const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { performance, monitorEventLoopDelay } = require('perf_hooks');
const assert = require('assert/strict');
const { Pool } = require('pg');
if (process.env.AFF_LOAD_WORKER === '1') {
  process.env.NODE_ENV = 'test';
  const logger = require('../src/utils/logger');
  for (const key of ['logEnter','logLeave','log','warning','error']) logger[key] = () => {};
  // This fixture never contacts a provider. Delay models a 100 ms provider response.
  const shopee = require('../src/services/shopeeService');
  const realConvert = shopee.convertShopeeLink;
  shopee.convertShopeeLink = async (...args) => { await new Promise(r => setTimeout(r, 100)); return realConvert(...args); };
  let bypass = false;
  const security = require('../src/utils/securityMiddleware');
  const realLimiter = security.createRateLimiter;
  security.createRateLimiter = options => { const limiter = realLimiter(options); return (req,res,next) => bypass ? next() : limiter(req,res,next); };
  const d = require('../src/services/dbService');
  let server;
  const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
  (async () => {
    await d.initPostgresIfConfigured();
    const db = d.ensureDbLoaded();
    for(let i=0;i<20;i++) db.users.push({id:'load_user_'+i,code:'LOAD'+i,phone:'090000'+String(i).padStart(4,'0'),role:'user',passwordHash:'fixture',tokenVersion:1,createdAt:new Date().toISOString()});
    db.clicks = Array.from({length:60000},(_,i)=>({clickId:'load_click_'+i,userId:'load_user_'+(i%20),userCode:'LOAD'+(i%20),platform:'shopee',affiliateUrl:'https://shopee.vn/product/123/456',createdAt:new Date(Date.now()-86400000).toISOString()}));
    await d.saveDb(db);
    server = require('../server').listen(0,'127.0.0.1');
    await new Promise(r=>server.once('listening',r));
    process.send({ready:true,port:server.address().port,tokens:db.users.filter(u=>u.id.startsWith('load_user_')).map(u=>d.createToken(u))});
  })().catch(e=>{process.send({error:e.message});process.exitCode=1;});
  process.on('message',async msg=>{
    if(msg.action==='bypass'){bypass=true;process.send({bypass:true});}
    if(msg.action==='stats'){process.send({stats:{rssMB:process.memoryUsage().rss/1048576,heapMB:process.memoryUsage().heapUsed/1048576,eventLoopP99Ms:delay.percentile(99)/1e6,eventLoopMaxMs:delay.max/1e6}});delay.reset();}
    if(msg.action==='stop'){delay.disable();await new Promise(r=>server.close(r));await d.getPgPool().end();process.disconnect();}
  });
} else {
(async()=>{
  const url=new URL(process.env.PG_TEST_URL||'');assert.ok(['localhost','127.0.0.1'].includes(url.hostname));
  const admin=new Pool({connectionString:url.toString()}); const name='aff_capacity_'+Date.now();let child,db;
  const report={model:{users:20,clicksPerUserDay:5000,conversionsPerUserDay:100,seedClicks:60000,providerDelayMs:100,logging:'muted',limiter:'real control test, then bypassed for saturation measurement'},stages:[]};
  try{
    await admin.query('CREATE DATABASE '+name);url.pathname='/'+name;db=new Pool({connectionString:url.toString()});
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','SYSTEMROOT','COMSPEC','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'].includes(k.toUpperCase())));
    child=fork(__filename,[],{env:{...env,NODE_ENV:'test',AFF_LOAD_WORKER:'1',TEST_DATABASE_URL:url.toString()},stdio:['ignore','ignore','inherit','ipc']});
    const ready=await new Promise((resolve,reject)=>{child.once('message',m=>m.ready?resolve(m):reject(new Error(m.error)));child.once('error',reject)});
    const base='http://127.0.0.1:'+ready.port;
    const post=(i,user=i%20)=>fetch(base+'/api/convert',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+ready.tokens[user]},body:JSON.stringify({text:'https://shopee.vn/product/123/'+(456+i)}),signal:AbortSignal.timeout(120000)});
    async function stage(label,n,concurrency,fn){let cursor=0;const latency=[],statuses={};let invalid=0;const t=performance.now();await Promise.all(Array.from({length:concurrency},async()=>{while(cursor<n){const i=cursor++;const t0=performance.now();try{const {res,valid}=await fn(i);statuses[res.status]=(statuses[res.status]||0)+1;if(!valid)invalid++;}catch(e){statuses[e.name]=(statuses[e.name]||0)+1;invalid++;}latency.push(performance.now()-t0);}}));latency.sort((a,b)=>a-b);const result={label,requests:n,concurrency,seconds:(performance.now()-t)/1000,p50Ms:latency[Math.floor(n*.5)],p95Ms:latency[Math.floor(n*.95)],p99Ms:latency[Math.floor(n*.99)],statuses,invalid};result.requestsPerSecond=n/result.seconds;report.stages.push(result);console.log(JSON.stringify(result));}
    await stage('real-rate-limit-one-IP',40,1,async i=>{const res=await post(i);const body=await res.json();return {res,valid:res.status===429||body.items?.[0]?.status==='success'}});
    assert.equal(report.stages[0].statuses[200], 40, '20 accounts sharing one IP must not share the old 30-request quota');
    await stage('real-rate-limit-single-account',35,1,async i=>{const res=await post(i,0);const body=await res.json();return {res,valid:res.status===429||body.items?.[0]?.status==='success'}});
    assert.equal(report.stages[1].statuses[200], 28, 'Account already used two requests in the shared-IP stage');
    assert.equal(report.stages[1].statuses[429], 7);
    await new Promise(r=>{child.once('message',r);child.send({action:'bypass'})});
    await stage('100000-redirects-20-users',100000,20,async i=>{const res=await fetch(base+'/go/load_click_'+(i%60000),{redirect:'manual',signal:AbortSignal.timeout(120000)});const valid=res.status===302&&res.headers.get('location')==='https://shopee.vn/product/123/456';await res.text();return {res,valid}});
    child.send({action:'stats'});report.redirectStats=await new Promise(r=>child.once('message',m=>r(m.stats)));
    const before=Number((await db.query('SELECT COUNT(*) FROM clicks')).rows[0].count);
    await stage('2000-conversions-20-users-limiter-bypassed',2000,20,async i=>{const res=await post(i);const body=await res.json();return {res,valid:res.status===200&&body.items?.[0]?.status==='success'}});
    report.persistedNewClicks=Number((await db.query('SELECT COUNT(*) FROM clicks')).rows[0].count)-before;
    child.send({action:'stats'});report.convertStats=await new Promise(r=>child.once('message',m=>r(m.stats)));
    report.databaseBytes=Number((await db.query('SELECT pg_database_size(current_database()) AS bytes')).rows[0].bytes);
    fs.writeFileSync(process.env.CAPACITY_REPORT||path.join(require('os').tmpdir(),'aff-capacity-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({persistedNewClicks:report.persistedNewClicks,redirectStats:report.redirectStats,convertStats:report.convertStats,databaseBytes:report.databaseBytes}));
  }finally{if(child&&child.exitCode===null)await new Promise(r=>{child.once('exit',r);child.send({action:'stop'})});if(db)await db.end();await admin.query('DROP DATABASE IF EXISTS '+name);await admin.end();}
})().catch(e=>{console.error(e);process.exitCode=1});
}
