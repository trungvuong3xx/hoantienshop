// Explicit credentials only; never loads .env or initializes application state.
// Default is read-only validation. --apply requires a new backup file path.
const fs = require('fs');
const { Client } = require('pg');
const { decryptSettingsObject, encryptSettingsObject } = require('../src/utils/secretCrypto');

async function main() {
  const { ROTATION_DATABASE_URL: url, OLD_SETTINGS_KEY: oldKey, NEW_SETTINGS_KEY: newKey, ROTATION_BACKUP_PATH: backup } = process.env;
  const apply = process.argv.includes('--apply');
  if (!url || !oldKey?.trim() || !newKey?.trim() || (apply && !backup)) {
    throw new Error('Set ROTATION_DATABASE_URL, OLD_SETTINGS_KEY, NEW_SETTINGS_KEY; --apply also requires ROTATION_BACKUP_PATH (new file).');
  }
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    await client.query('SET LOCAL lock_timeout=5000');
    await client.query('SET LOCAL statement_timeout=15000');
    const result = await client.query("SELECT payload,version FROM hoantienshop_state WHERE id='main'" + (apply ? ' FOR UPDATE' : ''));
    if (result.rowCount !== 1 || !result.rows[0].payload?.settings) throw new Error('Missing settings envelope');
    const before = result.rows[0];
    const plain = decryptSettingsObject(before.payload.settings, oldKey);
    const encrypted = encryptSettingsObject(plain, newKey);
    if (JSON.stringify(decryptSettingsObject(encrypted, newKey)) !== JSON.stringify(plain)) throw new Error('Round-trip validation failed');
    if (apply) {
      // Preserve the original envelope unchanged; legacy plaintext requires protected storage too.
      fs.writeFileSync(backup, JSON.stringify({ capturedAt: new Date().toISOString(), ...before }), { flag: 'wx', mode: 0o600 });
      await client.query("UPDATE hoantienshop_state SET payload=$1,version=version+1,updated_at=NOW() WHERE id='main'", [{ ...before.payload, settings: encrypted }]);
    }
    await client.query('COMMIT');
    console.log(apply ? 'Rotated and verified settings. Deploy all workers with NEW_SETTINGS_KEY as SETTINGS_ENCRYPTION_KEY before resuming traffic.' : 'Preview passed. No database changes. Drain all workers and back up the database before --apply.');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { await client.end(); }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { main };
