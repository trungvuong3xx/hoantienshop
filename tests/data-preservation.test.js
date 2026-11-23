process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_URL = '';
const assert = require('assert/strict');
const crypto = require('../src/utils/secretCrypto');
const oldKey = crypto.deriveSettingsAesKey('fixture-old');
const original = crypto.encryptSettingsObject({ postbackToken: 'fixture-secret' }, 'fixture-old');
for (const key of [null, crypto.deriveSettingsAesKey('wrong')]) {
  assert.throws(() => crypto.decryptSecretValue(original.postbackToken, key), { code: 'SETTINGS_DECRYPT_FAILED' });
}
assert.throws(() => crypto.decryptSecretValue('enc:v1:broken', oldKey), { code: 'SETTINGS_DECRYPT_FAILED' });
const rotated = crypto.encryptSettingsObject(crypto.decryptSettingsObject(original, 'fixture-old'), 'fixture-new');
assert.equal(crypto.decryptSettingsObject(rotated, 'fixture-new').postbackToken, 'fixture-secret');
const d = require('../src/services/dbService');
const app = require('../server');
(async () => {
  const db = d.ensureDbLoaded();
  const user = { id: 'archive-empty', code: 'ARCHIVE', name: 'Fixture', phone: '0900000001', role: 'user', tokenVersion: 1, passwordHash: d.hashPassword('Fixture!123'), createdAt: '2020-01-02T00:00:00.000Z' };
  db.users.push(user); await d.saveDb(db);
  const token = d.createToken(user);
  const adminToken = d.createToken(db.users.find(u => u.role === 'admin'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(base + '/api/admin/users/action', { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', userId: user.id }) });
    assert.equal(response.status, 200, await response.text());
    const saved = d.ensureDbLoaded().users.find(u => u.id === user.id);
    assert.ok(saved.isDeleted && saved.accountLocked);
    assert.equal(saved.phone, user.phone);
    assert.equal(saved.tokenVersion, 2);
    assert.equal(saved.createdAt, user.createdAt);
    const me = await fetch(base + '/api/user/me', { headers: { Authorization: `Bearer ${token}` } });
    assert.ok([401,403].includes(me.status));
    console.log('PASS: crypto fail-closed, rotation, empty-user archive and revoked session');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
