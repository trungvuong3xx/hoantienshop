process.env.NODE_ENV = 'test';
const assert = require('assert/strict');
const { fork } = require('child_process');
const { Pool } = require('pg');
if (process.env.AFF_PG_WORKER === '1') {
  const d = require('../src/services/dbService');
  process.env.POSTBACK_SECRET = 'integration-webhook-only';
  let server; const unhandled=[]; process.on('unhandledRejection', e=>unhandled.push(e.code || e.message));
  (async () => { await d.initPostgresIfConfigured(); process.send({ ready: true }); })().catch(e => { process.send({ error: e.message }); process.exitCode = 1; });
  process.on('message', async ({ id, action, input }) => {
    try {
      let result;
      if (action === 'stop') { if (server) await new Promise(r => server.close(r)); await d.getPgPool().end(); process.disconnect(); return; }
      if (action === 'seed') { const db = d.ensureDbLoaded(); d.appendLedgerEntry(db.users[0].id, 'admin_adjustment', 500000, 'integration-credit'); await d.saveDb(db); result = true; }
      if (action === 'http') { server = require('../server').listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); result = { port: server.address().port, token: d.createToken(d.ensureDbLoaded().users[0]) }; }
      if (action === 'reassignProbe') {
        const db=d.ensureDbLoaded(); const users=db.users.filter(u=>u.role!=='admin');const [u,v]=users;
        const order={orderSn:'AUDIT_TRANSFER',userId:u.id,userCode:u.code,status:'approved',userCashbackAmount:6300};db.orders.push(order);
        d.recalculateAllWallets({persist:false});await d.saveDb(db);
        order.userId=v.id;order.userCode=v.code;d.recalculateAllWallets({persist:false});
        result={displayed:v.balanceAvailable,ledger:db.ledger.filter(e=>e.userId===v.id).reduce((s,e)=>s+e.amount,0)};
        await d.saveDb(db);await d.reloadStateFromPostgres();result.afterReload=db.users.find(x=>x.id===v.id).balanceAvailable;
      }
      if (action === 'platformProbe') {
        const db=d.ensureDbLoaded();const upsert=require('../src/services/cashbackController').upsertNetworkOrder;
        upsert(db,{orderSn:'SAME_PLATFORM_ID',platform:'shopee',grossCommission:10000,status:'pending'});
        upsert(db,{orderSn:'SAME_PLATFORM_ID',platform:'tiktok',grossCommission:20000,status:'pending'});
        await d.saveDb(db); await d.reloadStateFromPostgres();
        result=db.orders.filter(o=>o.orderSn==='SAME_PLATFORM_ID').map(o=>({platform:o.platform,gross:o.grossCommission}));
      }
      if (action === 'unhandled') result=unhandled;
      if (action === 'paid') result = await d.settleWithdrawal(input, 'paid', { id: 'integration-admin' });
      if (action === 'archive') result = await d.archiveWithdrawal(input, { id: 'integration-admin' });
      if (action === 'refund') { const db = d.ensureDbLoaded(); result = await d.refundWithdrawal(db, db.withdrawals.find(w => w.id === input)); }
      if (action === 'clicks') { const db = d.ensureDbLoaded(); db.clicks = Array.from({ length: 6001 }, (_, i) => ({ clickId: 'click_' + i, createdAt: new Date().toISOString() })); await d.saveDb(db); await d.reloadStateFromPostgres(); result = db.clicks.length; }
      if (action === 'appendClick') { await d.appendClickRecords([input]); result = true; }
      if (action === 'findClick') result = await d.findClickById(input);
      if (action === 'cachedClick') result = d.ensureDbLoaded().clicks.some(c => c.clickId === input);
      if (action === 'cachedLedger') result = d.ensureDbLoaded().ledger.filter(e => e.note === input).length;
      if (action === 'claimBatch') {
        const db = d.ensureDbLoaded();
        db.orders.push(...input);
        await d.saveDb(db); await d.reloadStateFromPostgres();
        result = db.orders.filter(o => input.some(i => i.orderSn === o.orderSn));
      }
      if (action === 'claimSingle') {
        await d.persistOrderToPostgres(input); await d.reloadStateFromPostgres();
        result = d.ensureDbLoaded().orders.find(o => o.orderSn === input.orderSn);
      }
      if (action === 'reload') { await d.reloadStateFromPostgres(); result = true; }
      if (action === 'save') { const db = d.ensureDbLoaded(); db.settings.siteName = input; await d.saveDb(db); result = true; }
      if (action === 'saveDirtyOrder') { const db = d.ensureDbLoaded(); db.orders.push({ orderSn: 'must-not-survive', platform: 'shopee', status: 'pending' }); await d.saveDb(db); result = true; }
      if (action === 'withdraw') result = await d.executeAtomicWithdrawal({ userId: 'usr_admin', amount: 50000, bankName: 'MB', bankAccount: '12345678', bankOwner: 'TEST USER', minWithdraw: 50000, ...input });
      process.send({ id, result });
    } catch (e) { process.send({ id, error: e.message, code: e.code }); }
  });
} else {
  (async () => {
    const url = new URL(process.env.PG_TEST_URL || '');
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Integration tests require an explicit localhost PostgreSQL URL');
    const database = 'aff_integration_' + Date.now();
    const admin = new Pool({ connectionString: url.toString() });
    const children = [];
    let check;
    try {
      await admin.query('CREATE DATABASE ' + database);
      url.pathname = '/' + database;
      check = new Pool({ connectionString: url.toString() });
      const schemaSource = require('fs').readFileSync(require('path').join(__dirname, '../src/services/dbService.js'), 'utf8');
      await check.query(schemaSource.match(/CREATE TABLE IF NOT EXISTS orders \([\s\S]+?\n        \);/)[0]);
      await check.query("INSERT INTO orders(order_sn, platform, status) VALUES ('LEGACY_SCHEMA_FIXTURE', NULL, 'pending')");
      const start = () => new Promise((resolve, reject) => {
        const child = fork(__filename, [], { env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].includes(key.toUpperCase()))), NODE_ENV: 'test', TEST_DATABASE_URL: url.toString(), AFF_PG_WORKER: '1', JWT_SECRET: 'audit-shared-secret-not-for-production-123456' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        children.push(child); let errorText = ''; child.stderr.on('data', b => errorText += b);
        child.once('message', msg => msg.ready ? resolve(child) : reject(new Error(msg.error)));
        child.once('error', reject); child.once('exit', code => { if (code) reject(new Error(errorText)); });
      });
      let seq = 0;
      const call = (child, action, input) => new Promise((resolve, reject) => {
        const id = ++seq; const timer = setTimeout(() => { child.off('message', receive); reject(new Error('Worker timeout')); }, 25000);
        function receive(msg) { if (msg.id !== id) return; clearTimeout(timer); child.off('message', receive); resolve(msg); }
        child.on('message', receive); child.send({ id, action, input });
      });
      const a = await start(); assert.equal((await call(a, 'seed')).error, undefined);
      const b = await start();
      assert.equal((await check.query("SELECT platform FROM orders WHERE order_sn='LEGACY_SCHEMA_FIXTURE'")).rows[0].platform, 'shopee');
      assert.equal((await check.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='orders'::regclass AND contype='p'")).rows[0].definition, 'PRIMARY KEY (platform, order_sn)');
      console.log('PASS: legacy single-key orders table migrates idempotently across two workers without losing rows');
      assert.equal((await call(a, 'save', 'winner')).error, undefined);
      assert.equal((await call(b, 'save', 'loser')).code, 'STATE_CONFLICT');
      assert.equal((await check.query("SELECT payload->'settings'->>'siteName' AS name FROM hoantienshop_state")).rows[0].name, 'winner');
      console.log('PASS: stale write rejected without silently dropping mutation');
      await call(a, 'reload'); await call(b, 'reload');
      const [w1, w2] = await Promise.all([call(a, 'withdraw', { idempotencyKey: 'same-key' }), call(b, 'withdraw', { idempotencyKey: 'same-key' })]);
      assert.equal(w1.error, undefined); assert.equal(w2.error, undefined);
      assert.equal(w1.result.withdrawal.id, w2.result.withdrawal.id);
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM withdrawals')).rows[0].count), 1);
      assert.equal(Number((await check.query("SELECT SUM(amount) AS balance FROM ledger WHERE user_id='usr_admin'")).rows[0].balance), 450000);
      console.log('PASS: two processes, one idempotency key, one withdrawal and one debit');
      await call(b, 'reload');
      assert.equal((await call(a, 'withdraw', { idempotencyKey: 'second-key' })).error, undefined);
      assert.equal((await call(b, 'save', 'stale-after-withdrawal')).code, 'STATE_CONFLICT');
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM withdrawals')).rows[0].count), 2);
      console.log('PASS: stale snapshot cannot delete a newly committed withdrawal');
      await call(a, 'reload'); await call(b, 'reload');
      assert.equal((await call(a, 'paid', w1.result.withdrawal.id)).error, undefined);
      assert.equal((await call(b, 'refund', w1.result.withdrawal.id)).code, 'WITHDRAWAL_CONFLICT');
      assert.equal(Number((await check.query("SELECT COUNT(*) FROM ledger WHERE type = 'withdrawal_refund'")).rows[0].count), 0);
      assert.equal((await check.query('SELECT status FROM withdrawals WHERE id=$1', [w1.result.withdrawal.id])).rows[0].status, 'paid');
      console.log('PASS: stale refund after paid rolls back both status and ledger');
      await call(a, 'reload');
      assert.equal((await call(a, 'clicks')).result, 6001);
      console.log('PASS: 6001 recent clicks survive PostgreSQL save and reload');
      const http = (await call(a, 'http')).result;
      const endpoint = 'http://127.0.0.1:' + http.port + '/api/admin/settings';
      const headers = { Authorization: 'Bearer ' + http.token };
      assert.equal((await fetch(endpoint, { headers })).status, 200);
      await check.query("UPDATE users SET token_version = token_version + 1 WHERE id='usr_admin'");
      assert.equal((await fetch(endpoint, { headers })).status, 403);
      console.log('PASS: revoked database token denied despite stale instance cache');
      await call(a, 'reload'); await call(b, 'reload');
      const version = (await check.query('SELECT version FROM hoantienshop_state')).rows[0].version;
      const click = { clickId: 'incremental-click', affiliateUrl: 'https://shopee.vn/product/123/456', createdAt: new Date().toISOString() };
      assert.equal((await call(a, 'appendClick', click)).error, undefined);
      assert.equal((await call(a, 'appendClick', click)).error, undefined);
      assert.equal((await check.query('SELECT version FROM hoantienshop_state')).rows[0].version, version);
      assert.equal((await call(b, 'findClick', click.clickId)).result.affiliateUrl, click.affiliateUrl);
      assert.equal((await call(b, 'save', 'snapshot-after-insert')).error, undefined);
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM clicks WHERE click_id=$1', [click.clickId])).rows[0].count), 1);
      console.log('PASS: incremental click is replay-safe, visible cross-instance, preserved by older snapshot');
      await check.query("CREATE FUNCTION reject_fixture_click() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.click_id = 'fail-click' THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_fixture BEFORE INSERT ON clicks FOR EACH ROW EXECUTE FUNCTION reject_fixture_click();");
      assert.ok((await call(a, 'appendClick', { ...click, clickId: 'fail-click' })).error);
      assert.equal((await call(a, 'cachedClick', 'fail-click')).result, false);
      assert.equal(Number((await check.query("SELECT COUNT(*) FROM clicks WHERE click_id='fail-click'")).rows[0].count), 0);
      console.log('PASS: failed database insert does not publish a phantom click to cache');
      const attributed = { ...click, clickId: 'aabbccddeeff0011', userId: 'usr_admin', userCode: 'TRUNGVUONG3X' };
      assert.equal((await call(a, 'appendClick', attributed)).error, undefined);
      const otherHttp = (await call(b, 'http')).result;
      const postback = await fetch('http://127.0.0.1:' + otherHttp.port + '/api/webhooks/postback', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-postback-token': 'integration-webhook-only' },
        body: JSON.stringify({ orderSn: 'CROSS-INSTANCE-ORDER', clickId: attributed.clickId, grossCommission: 10000, status: 'pending', platform: 'shopee' })
      });
      assert.equal(postback.status, 200);
      assert.equal((await check.query("SELECT user_id FROM orders WHERE order_sn='CROSS-INSTANCE-ORDER'")).rows[0].user_id, 'usr_admin');
      console.log('PASS: webhook on another instance attributes newly inserted click to its owner');
      await call(a, 'reload'); await call(b, 'reload');
      const racing = await call(a, 'withdraw', { idempotencyKey: 'settlement-race' });
      assert.equal(racing.error, undefined);
      const raceId = racing.result.withdrawal.id;
      await call(b, 'reload');
      const transitions = await Promise.all([call(a, 'paid', raceId), call(b, 'refund', raceId)]);
      assert.equal(transitions.filter(r => !r.error).length, 1);
      const settled = (await check.query('SELECT status FROM withdrawals WHERE id=$1', [raceId])).rows[0].status;
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM ledger WHERE ref_id=$1', ['withdraw_refund_' + raceId])).rows[0].count), settled === 'rejected' ? 1 : 0);
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM audit_logs WHERE target_id=$1 AND action=$2', [raceId, 'update_withdrawal'])).rows[0].count), 1);
      console.log('PASS: competing paid/refund transitions produce one terminal state and one atomic audit');
      const fault = await call(a, 'withdraw', { idempotencyKey: 'audit-rollback' });
      assert.equal(fault.error, undefined);
      const faultId = fault.result.withdrawal.id;
      const beforeBalance = (await check.query("SELECT balance_available FROM users WHERE id='usr_admin'")).rows[0].balance_available;
      await check.query("CREATE FUNCTION reject_fixture_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit fixture failure'; END $$; CREATE TRIGGER reject_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_fixture_audit();");
      assert.ok((await call(a, 'refund', faultId)).error);
      assert.equal((await check.query('SELECT status FROM withdrawals WHERE id=$1', [faultId])).rows[0].status, 'pending');
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM ledger WHERE ref_id=$1', ['withdraw_refund_' + faultId])).rows[0].count), 0);
      assert.equal((await check.query("SELECT balance_available FROM users WHERE id='usr_admin'")).rows[0].balance_available, beforeBalance);
      await check.query('DROP TRIGGER reject_audit ON audit_logs');
      assert.equal((await call(a, 'refund', faultId)).error, undefined);
      await call(b, 'reload');
      assert.equal((await call(b, 'refund', faultId)).error, undefined);
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM audit_logs WHERE target_id=$1', [faultId])).rows[0].count), 1);
      console.log('PASS: audit failure rolls back refund, status and balance; replay creates no duplicate audit');
      await call(b, 'reload');
      const adjustment = await fetch('http://127.0.0.1:' + otherHttp.port + '/api/admin/users/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + otherHttp.token },
        body: JSON.stringify({ action: 'adjust_balance', userId: 'usr_admin', amount: 123, note: 'durable-audit-fixture' })
      });
      assert.equal(adjustment.status, 200);
      assert.equal(Number((await check.query("SELECT COUNT(*) FROM audit_logs WHERE action='adjust_balance' AND details->>'note'='durable-audit-fixture'")).rows[0].count), 1);
      assert.equal(Number((await check.query("SELECT COUNT(*) FROM ledger WHERE type='admin_adjustment' AND amount=123")).rows[0].count), 1);
      console.log('PASS: admin adjustment HTTP response includes durable ledger and audit in the same save');
      const corrupt = await call(a, 'withdraw', { idempotencyKey: 'mismatched-reservation' });
      assert.equal(corrupt.error, undefined);
      const corruptId = corrupt.result.withdrawal.id;
      await check.query('UPDATE withdrawals SET amount=amount+1 WHERE id=$1', [corruptId]);
      assert.equal((await call(a, 'paid', corruptId)).code, 'WITHDRAWAL_INTEGRITY');
      assert.equal((await call(a, 'refund', corruptId)).code, 'WITHDRAWAL_INTEGRITY');
      assert.equal((await check.query('SELECT status FROM withdrawals WHERE id=$1', [corruptId])).rows[0].status, 'pending');
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM ledger WHERE ref_id=$1', ['withdraw_refund_' + corruptId])).rows[0].count), 0);
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM audit_logs WHERE target_id=$1', [corruptId])).rows[0].count), 0);
      console.log('PASS: mismatched reservation blocks both payment and refund without changing financial state');
      const archiveCandidate = await call(a, 'withdraw', { idempotencyKey: 'archive-replay' });
      assert.equal(archiveCandidate.error, undefined);
      const archiveId = archiveCandidate.result.withdrawal.id;
      await call(b, 'reload');
      await check.query('CREATE TRIGGER reject_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_fixture_audit()');
      assert.ok((await call(a, 'archive', archiveId)).error);
      const failedArchive = (await check.query('SELECT status, archived_at FROM withdrawals WHERE id=$1', [archiveId])).rows[0];
      assert.equal(failedArchive.status, 'pending'); assert.equal(failedArchive.archived_at, null);
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM ledger WHERE ref_id=$1', ['withdraw_refund_' + archiveId])).rows[0].count), 0);
      await check.query('DROP TRIGGER reject_audit ON audit_logs');
      const deleted = await fetch('http://127.0.0.1:' + otherHttp.port + '/api/admin/withdrawals/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + otherHttp.token },
        body: JSON.stringify({ id: archiveId, hardDelete: true })
      });
      assert.equal(deleted.status, 200); assert.equal((await deleted.json()).archived, true);
      assert.equal((await call(a, 'archive', archiveId)).error, undefined);
      const replayArchived = await call(a, 'withdraw', { idempotencyKey: 'archive-replay' });
      assert.equal(replayArchived.error, undefined);
      assert.equal(replayArchived.result.withdrawal.id, archiveId);
      assert.equal(replayArchived.result.withdrawal.status, 'rejected');
      assert.ok((await call(a, 'withdraw', { idempotencyKey: 'archive-replay', amount: 60000 })).error);
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM ledger WHERE ref_id=$1', ['withdraw_refund_' + archiveId])).rows[0].count), 1);
      assert.equal(Number((await check.query("SELECT COUNT(*) FROM audit_logs WHERE target_id=$1 AND action='archive_withdrawal'", [archiveId])).rows[0].count), 1);
      const list = await fetch('http://127.0.0.1:' + otherHttp.port + '/api/admin/withdrawals', { headers: { Authorization: 'Bearer ' + otherHttp.token } });
      assert.equal(list.status, 200); assert.ok(!(await list.json()).withdrawals.some(w => w.id === archiveId));
      await call(a, 'reload');
      assert.equal((await call(a, 'save', 'after-archive')).error, undefined);
      assert.ok((await check.query('SELECT archived_at FROM withdrawals WHERE id=$1', [archiveId])).rows[0].archived_at);
      assert.equal((await call(a, 'archive', w1.result.withdrawal.id)).code, 'WITHDRAWAL_CONFLICT');
      console.log('PASS: atomic archive/refund, audit rollback, durable replay, hidden listings and snapshot preservation');
      await call(b, 'reload');
      await check.query('CREATE TRIGGER reject_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_fixture_audit()');
      const failedAdjustment = await fetch('http://127.0.0.1:' + otherHttp.port + '/api/admin/users/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + otherHttp.token },
        body: JSON.stringify({ action: 'adjust_balance', userId: 'usr_admin', amount: 777, note: 'failed-adjustment-must-not-return' })
      });
      assert.equal(failedAdjustment.status, 500);
      assert.equal((await call(b, 'cachedLedger', 'failed-adjustment-must-not-return')).result, 0);
      await check.query('DROP TRIGGER reject_audit ON audit_logs');
      assert.equal((await call(b, 'save', 'after-failed-adjustment')).error, undefined);
      assert.equal(Number((await check.query("SELECT COUNT(*) FROM ledger WHERE note='failed-adjustment-must-not-return'")).rows[0].count), 0);
      console.log('PASS: failed adjustment is discarded from cache and cannot return in a later save');
      await check.query('ALTER TABLE orders RENAME TO fixture_unavailable_orders');
      assert.ok((await call(b, 'saveDirtyOrder')).error);
      assert.equal((await call(b, 'cachedLedger', 'anything')).code, 'CACHE_UNAVAILABLE');
      assert.equal((await call(b, 'save', 'blocked-while-invalid')).code, 'CACHE_UNAVAILABLE');
      await check.query('ALTER TABLE fixture_unavailable_orders RENAME TO orders');
      assert.equal((await call(b, 'reload')).error, undefined);
      assert.equal((await call(b, 'save', 'recovered')).error, undefined);
      console.log('PASS: failed cache recovery blocks reads/writes until authoritative reload succeeds');
      const fixtures = [
        { orderSn: 'TEST_CLAIM_VERIFIED', status: 'pending', claimVerified: true, claimRejected: false },
        { orderSn: 'TEST_CLAIM_REJECTED', status: 'pending', claimVerified: false, claimRejected: true, claimRejectReason: 'TÃƒÂ i khoÃ¡ÂºÂ£n nhÃ¡ÂºÂ­n Ã„â€˜Ã†Â¡n khÃƒÂ´ng khÃ¡Â»â€ºp.' }
      ];
      const roundtrip = await call(b, 'claimBatch', fixtures);
      assert.equal(roundtrip.error, undefined);
      for (const expected of fixtures) {
        const actual = roundtrip.result.find(o => o.orderSn === expected.orderSn);
        assert.equal(actual.claimVerified, expected.claimVerified);
        assert.equal(actual.claimRejected, expected.claimRejected);
        assert.equal(actual.claimRejectReason, expected.claimRejectReason || null);
      }
      const corrected = await call(b, 'claimSingle', { ...fixtures[1], claimVerified: true, claimRejected: false, claimRejectReason: null });
      assert.equal(corrected.error, undefined);
      assert.equal(corrected.result.claimVerified, true); assert.equal(corrected.result.claimRejected, false);
      assert.equal(corrected.result.claimRejectReason, null);
      console.log('PASS: claim flags/reason survive batch and single-row persistence and reload');
      const snapshot = async () => {
        const state = {};
        for (const table of ['users', 'orders', 'ledger', 'withdrawals', 'clicks', 'audit_logs', 'hoantienshop_state']) {
          state[table] = (await check.query(`SELECT row_to_json(t) AS row FROM ${table} t`)).rows.map(r => JSON.stringify(r.row)).sort();
        }
        return state;
      };
      const beforeInspection = await snapshot();
      const inspect = await fetch('http://127.0.0.1:' + otherHttp.port + '/api/admin/cleanup-test-data', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + otherHttp.token }, body: '{}'
      });
      assert.equal(inspect.status, 200);
      const report = await inspect.json(); assert.equal(report.previewOnly, true);
      assert.ok(report.candidates.orderSns.includes(fixtures[0].orderSn));
      assert.deepEqual(await snapshot(), beforeInspection);
      console.log('PASS: legacy cleanup endpoint reports candidates without changing any persisted data');
      await assert.rejects(check.query("DELETE FROM ledger WHERE ref_id='integration-credit'"));
      assert.equal(Number((await check.query("SELECT COUNT(*) FROM ledger WHERE ref_id='integration-credit'")).rows[0].count), 1);
      console.log('PASS: ledger delete protection remains active after inspection');

      const observations={};
      const post=async(port,path,data,token)=>fetch('http://127.0.0.1:'+port+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(data)});
      await call(a,'reload');await call(b,'reload');
      const reg=await post(http.port,'/api/auth/register',{name:'Audit Cross Instance',phone:'0900000111',password:'Audit!123'});
      const registered=await reg.json(); assert.equal(reg.status,200);
      const same=await fetch('http://127.0.0.1:'+http.port+'/api/user/me',{headers:{Authorization:'Bearer '+registered.token}});
      const other=await fetch('http://127.0.0.1:'+otherHttp.port+'/api/user/me',{headers:{Authorization:'Bearer '+registered.token}});
      observations.crossInstanceRegistration={same:same.status,other:other.status};
      await call(b,'reload');
      const lock=await post(http.port,'/api/admin/users/action',{userId:registered.user.id,action:'toggle_lock'},otherHttp.token);assert.equal(lock.status,200);
      const lockedLogin=await post(http.port,'/api/auth/login',{identifier:'0900000111',password:'Audit!123'});
      observations.lockedLogin={status:lockedLogin.status,returnsUser:Boolean((await lockedLogin.json()).user)};
      await call(a,'reload');await call(b,'reload');
      const reg2=await post(http.port,'/api/auth/register',{name:'Audit Other',phone:'0900000222',password:'Audit!123'});assert.equal(reg2.status,200);
      observations.reassignment=(await call(a,'reassignProbe')).result;
      observations.platformCollision=(await call(a,'platformProbe')).result;
      await call(b,'reload');
      const baseOrders='http://127.0.0.1:'+otherHttp.port+'/api/admin/orders?q=TEST_CLAIM_REJECTED';
      const cacheOrders=await (await fetch(baseOrders,{headers:{Authorization:'Bearer '+otherHttp.token}})).json();
      const sqlOrders=await (await fetch(baseOrders+'&preferSql=true',{headers:{Authorization:'Bearer '+otherHttp.token}})).json();
      observations.claimApiParity={cache:cacheOrders.orders?.[0]?.claimVerified??null,sql:sqlOrders.orders?.[0]?.claimVerified??null};
      const mixedStart = Date.now();
      const mutations = Array.from({ length: 20 }, (_, i) => ({ orderSn: 'MIXED_ORDER_' + i, platform: 'shopee', userCode: registered.user.code, totalCommission: 1000 + i, status: 'approved' }));
      const responses = await Promise.all(mutations.map((body, i) => post(i % 2 ? http.port : otherHttp.port, '/api/admin/orders', body, otherHttp.token)));
      for (let i = 0; i < responses.length; i++) {
        assert.ok([200,409].includes(responses[i].status), 'Unexpected mixed workload status: ' + responses[i].status);
        if (responses[i].status === 409) assert.equal((await post(http.port, '/api/admin/orders', mutations[i], otherHttp.token)).status, 200);
      }
      const mixedRows = await check.query("SELECT order_sn, user_cashback_amount FROM orders WHERE order_sn LIKE 'MIXED_ORDER_%'");
      assert.equal(mixedRows.rowCount, 20);
      const mismatch = await check.query('SELECT u.id FROM users u WHERE u.balance_available <> COALESCE((SELECT SUM(amount) FROM ledger WHERE user_id=u.id),0)');
      assert.equal(mismatch.rowCount, 0);
      console.log('PASS: 20 concurrent admin order writes across two processes plus conflict retries preserve all orders and ledger balances (' + (Date.now()-mixedStart) + ' ms)');
      // Make the logout instance stale again after the list endpoint reload.
      await call(a,'reload');await call(a,'save','logout-conflict-fixture');
      try {
        const logout=await fetch('http://127.0.0.1:'+otherHttp.port+'/api/auth/logout',{method:'POST',headers:{Authorization:'Bearer '+otherHttp.token},signal:AbortSignal.timeout(1200)});
        observations.logoutAfterConflict={status:logout.status};
      } catch(error) { observations.logoutAfterConflict={error:error.name,unhandled:(await call(b,'unhandled')).result}; }
      assert.deepEqual(observations.crossInstanceRegistration, { same: 200, other: 200 });
      assert.deepEqual(observations.lockedLogin, { status: 401, returnsUser: false });
      assert.deepEqual(observations.reassignment, { displayed: 6300, ledger: 6300, afterReload: 6300 });
      assert.deepEqual(observations.platformCollision.sort((x,y) => x.platform.localeCompare(y.platform)), [{ platform: 'shopee', gross: 10000 }, { platform: 'tiktok', gross: 20000 }]);
      assert.deepEqual(observations.claimApiParity, { cache: true, sql: true });
      assert.deepEqual(observations.logoutAfterConflict, { status: 200 });
      const revoked = await fetch('http://127.0.0.1:'+http.port+'/api/user/me', { headers: { Authorization: 'Bearer '+otherHttp.token } });
      assert.equal(revoked.status, 401);
      console.log('PASS: cross-instance auth, locked login, order ownership/platform persistence, claim parity and durable logout regression assertions');
      const secondUser = (await reg2.json()).user;
      const eventTime = Date.now() - 10000;
      const approved = { event_id: 'approved-event', orderSn: 'DURABLE_REPLAY', sub1: secondUser.code, platform: 'shopee', grossCommission: 10000, status: 'approved', eventTime };
      const webhook = (port, body) => fetch('http://127.0.0.1:'+port+'/api/webhooks/postback', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-postback-token': 'integration-webhook-only' }, body: JSON.stringify(body) });
      assert.equal((await webhook(http.port, approved)).status, 200);
      assert.equal((await webhook(otherHttp.port, { ...approved, event_id: 'cancel-event', status: 'cancelled', eventTime: eventTime + 1000 })).status, 200);
      const replay = await webhook(http.port, approved); assert.equal(replay.status, 200); assert.equal((await replay.json()).idempotent, true);
      assert.equal((await check.query("SELECT status FROM orders WHERE order_sn='DURABLE_REPLAY'")).rows[0].status, 'cancelled');
      assert.equal((await webhook(otherHttp.port, { ...approved, grossCommission: 30000 })).status, 409);
      assert.equal((await webhook(otherHttp.port, { ...approved, event_id: 'undated', eventTime: undefined })).status, 409);
      console.log('PASS: webhook receipts persist across instances; replay cannot resurrect cancellation and conflicting event IDs are rejected');
      const {writeFileSync}=require('fs');writeFileSync(require('path').join(__dirname,'../docs/final-audit/remediation-diagnostics.json'),JSON.stringify(observations,null,2));
      console.log('AUDIT OBSERVATIONS '+JSON.stringify(observations));
      if (process.env.PG_BIN) await require('./restoreFixture').verifyFixtureRestore(url.toString(), admin, check);
    } finally {
      await Promise.all(children.map(child => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.send({ action: 'stop' }); })));
      if (check) await check.end();
      await admin.query('DROP DATABASE IF EXISTS ' + database);
      await admin.end();
    }
  })().catch(e => { console.error(e); process.exitCode = 1; });
}
