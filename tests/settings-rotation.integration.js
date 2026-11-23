const assert = require('assert/strict');
const { Client } = require('pg');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { encryptSettingsObject, decryptSettingsObject } = require('../src/utils/secretCrypto');
(async () => {
  const url = new URL(process.env.PG_TEST_URL || '');
  assert.ok(['localhost','127.0.0.1'].includes(url.hostname));
  const admin = new Client({ connectionString: url.toString() });
  const name = 'aff_rotation_' + Date.now();
  await admin.connect();
  let db;
  try {
    await admin.query('CREATE DATABASE ' + name);
    url.pathname = '/' + name;
    db = new Client({ connectionString: url.toString() }); await db.connect();
    await db.query('CREATE TABLE hoantienshop_state(id text PRIMARY KEY, payload jsonb, version bigint, updated_at timestamptz)');
    const original = { settings: encryptSettingsObject({postbackToken:'fixture-token'},'fixture-old') };
    await db.query('INSERT INTO hoantienshop_state VALUES($1,$2,1,NOW())',['main',original]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'aff-key-rotation-'));
    const backup = path.join(dir,'encrypted-backup.json');
    const run = (args, oldKey='fixture-old') => spawnSync(process.execPath, [path.join(__dirname,'../scripts/rotate-settings-key.js'), ...args], {
      env: { ...process.env, ROTATION_DATABASE_URL: url.toString(), OLD_SETTINGS_KEY: oldKey, NEW_SETTINGS_KEY:'fixture-new', ROTATION_BACKUP_PATH:backup }, encoding:'utf8'
    });
    assert.equal(run([]).status,0);
    assert.equal(fs.existsSync(backup),false);
    assert.notEqual(run(['--apply'],'wrong').status,0);
    assert.deepEqual((await db.query('SELECT payload FROM hoantienshop_state')).rows[0].payload,original);
    assert.equal(run(['--apply']).status,0);
    const after = (await db.query('SELECT payload,version FROM hoantienshop_state')).rows[0];
    assert.equal(decryptSettingsObject(after.payload.settings,'fixture-new').postbackToken,'fixture-token');
    assert.equal(Number(after.version),2);
    assert.deepEqual(JSON.parse(fs.readFileSync(backup)).payload,original);
    assert.notEqual(run(['--apply'],'fixture-new').status,0, 'Must not overwrite backup');
    console.log('PASS: preview, wrong-key rollback, verified rotation, original encrypted backup and overwrite protection');
  } finally { if(db) await db.end(); await admin.query('DROP DATABASE '+name); await admin.end(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
