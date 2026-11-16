const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');

// Only the disposable database created by the regression harness may be dumped.
async function verifyFixtureRestore(sourceUrl, admin, source) {
  const url = new URL(sourceUrl);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.match(url.pathname, /^\/aff_integration_\d+$/);
  const database = 'aff_restore_' + Date.now();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aff-restore-'));
  const backup = path.join(directory, 'fixture.dump');
  const exe = name => path.join(process.env.PG_BIN, name + (process.platform === 'win32' ? '.exe' : ''));
  const command = (name, args) => {
    const result = spawnSync(exe(name), args, { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  };
  const tables = ['users', 'orders', 'ledger', 'withdrawals', 'clicks', 'audit_logs', 'webhook_receipts', 'hoantienshop_state'];
  const fingerprint = async pool => {
    const result = {};
    for (const table of tables) {
      const rows = (await pool.query(`SELECT row_to_json(t) AS row FROM ${table} t`)).rows.map(r => JSON.stringify(r.row)).sort();
      result[table] = { count: rows.length, sha256: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
    }
    return result;
  };
  let restored;
  try {
    const before = await fingerprint(source);
    command('pg_dump', ['--dbname', sourceUrl, '--format=custom', '--file', backup]);
    await admin.query('CREATE DATABASE ' + database);
    url.pathname = '/' + database;
    command('pg_restore', ['--dbname', url.toString(), '--no-owner', '--exit-on-error', backup]);
    restored = new Pool({ connectionString: url.toString() });
    assert.deepEqual(await fingerprint(restored), before);
    await assert.rejects(restored.query('DELETE FROM ledger'), /append-only/);
    assert.equal((await restored.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='orders'::regclass AND contype='p'")).rows[0].definition, 'PRIMARY KEY (platform, order_sn)');
    console.log('PASS: pg_dump/pg_restore preserves all eight tables, financial rows, order identity and append-only protection');
  } finally {
    if (restored) await restored.end();
    await admin.query('DROP DATABASE IF EXISTS ' + database);
    fs.rmSync(backup, { force: true });
    fs.rmdirSync(directory);
  }
}
module.exports = { verifyFixtureRestore };
