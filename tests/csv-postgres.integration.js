const assert = require('assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const { Pool } = require('pg');

(async () => {
  const url = new URL(process.env.PG_TEST_URL || '');
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Explicit localhost PostgreSQL required');
  const maintenance = new Pool({ connectionString: url.toString() });
  const database = 'aff_csv_' + Date.now();
  try {
    await maintenance.query('CREATE DATABASE ' + database);
    url.pathname = '/' + database;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].includes(key.toUpperCase())));
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, 'test_csv_import.js')], {
        env: { ...env, NODE_ENV: 'test', TEST_DATABASE_URL: url.toString(), ...(process.env.CSV_SAMPLE_PATH ? { CSV_SAMPLE_PATH: process.env.CSV_SAMPLE_PATH } : {}) }, stdio: 'inherit', windowsHide: true
      });
      const timer = setTimeout(() => { child.kill(); reject(new Error('CSV PostgreSQL timeout')); }, 30000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('CSV PostgreSQL test failed: ' + code)); });
    });
  } finally {
    await maintenance.query('DROP DATABASE IF EXISTS ' + database);
    await maintenance.end();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
