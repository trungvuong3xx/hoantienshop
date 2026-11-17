// Read-only checks. Never imports server/dbService, migrates, or bootstraps users.
const fs = require('fs');
const { parseEnv } = require('util');
const { getRedisConfig, inspectProductionConfig } = require('../src/utils/runtimeConfig');

async function run() {
  const args = process.argv.slice(2);
  const envIndex = args.indexOf('--env-file');
  if (envIndex >= 0 && !args[envIndex + 1]) throw new Error('Missing --env-file path');
  const env = envIndex >= 0 ? { ...process.env, ...parseEnv(fs.readFileSync(args[envIndex + 1], 'utf8')) } : process.env;
  const checks = inspectProductionConfig(env);
  if (args.includes('--live') && !checks.some(c => ['FAIL', 'NOT_TESTED'].includes(c.status))) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5000, query_timeout: 5000, max: 1 });
    try { await pool.query('SELECT 1'); checks.push({ name: 'databaseConnectivity', status: 'PASS' }); }
    catch { checks.push({ name: 'databaseConnectivity', status: 'FAIL', message: 'Database connection failed; inspect provider logs without exposing credentials.' }); }
    finally { await pool.end(); }
    const redis = getRedisConfig(env);
    try {
      const response = await fetch(redis.url.replace(/\/$/, '') + '/ping', { headers: { Authorization: 'Bearer ' + redis.token }, signal: AbortSignal.timeout(5000) });
      const result = await response.json();
      if (!response.ok || result.result !== 'PONG') throw new Error('PING failed');
      checks.push({ name: 'redisConnectivity', status: 'PASS' });
    } catch { checks.push({ name: 'redisConnectivity', status: 'FAIL', message: 'Redis PING failed.' }); }
  }
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), checks }, null, 2));
  if (checks.some(c => ['FAIL', 'NOT_TESTED'].includes(c.status)) || (args.includes('--strict') && checks.some(c => c.status === 'WARN'))) process.exitCode = 1;
}
run().catch(() => { console.error('Preflight could not read configuration or complete checks. No secret values printed.'); process.exitCode = 1; });
