process.env.NODE_ENV = 'test';
const assert = require('assert/strict');
const crypto = require('crypto');
const { getClientIp, createRateLimiter } = require('../src/utils/securityMiddleware');
const dbService = require('../src/services/dbService');
(async () => {
  const req = { ip: '127.0.0.1', headers: { 'x-forwarded-for': '198.51.100.1' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(getClientIp(req), '127.0.0.1');
  assert.equal(getClientIp({ headers: req.headers, socket: req.socket }), '127.0.0.1');
  const limiter = createRateLimiter({ max: 2, keyPrefix: 'regression-spoof' });
  let passed = 0, blocked = 0;
  for (let i = 0; i < 4; i++) {
    req.headers['x-forwarded-for'] = `198.51.100.${i}`;
    await limiter(req, { status(code) { assert.equal(code, 429); blocked++; return this; }, json() {} }, () => passed++);
  }
  assert.equal(passed, 2); assert.equal(blocked, 2);
  const identityLimiter = createRateLimiter({ max: 30, keyPrefix: 'account-quota-test', keyGenerator: req => req.verifiedUserId });
  let accountPassed = 0, accountBlocked = 0;
  const response = { status(code) { assert.equal(code, 429); accountBlocked++; return this; }, json() {} };
  for (let user = 0; user < 20; user++) {
    for (let attempt = 0; attempt < 30; attempt++) await identityLimiter({ ...req, verifiedUserId: 'user-' + user }, response, () => accountPassed++);
  }
  await identityLimiter({ ...req, verifiedUserId: 'user-0' }, response, () => accountPassed++);
  assert.equal(accountPassed, 600); assert.equal(accountBlocked, 1);
  const body = Buffer.from(JSON.stringify({ id: 'usr_admin', ver: 1, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
  const oldKey = 'hts_prod_jwt_secret_secure_token_key_hoantiensan_2026';
  const forged = body + '.' + crypto.createHmac('sha256', oldKey).update(body).digest('base64url');
  assert.equal(dbService.verifyToken(forged), null);
  const db = dbService.ensureDbLoaded();
  const user = db.users[0];
  assert.ok(dbService.verifyToken(dbService.createToken(user)));
  assert.equal(dbService.verifyPassword('trungvuong1881996A@', user.passwordHash), false);
  dbService.appendLedgerEntry(user.id, 'admin_adjustment', 200000, 'security-fixture-credit');
  const input = { userId: user.id, amount: 50000, bankName: 'MB', bankAccount: '12345678', bankOwner: 'TEST USER', minWithdraw: 50000, idempotencyKey: 'security-fixture-key' };
  const first = await dbService.executeAtomicWithdrawal(input);
  first.withdrawal.createdAt = new Date(Date.now() - 24 * 3600000).toISOString();
  const replay = await dbService.executeAtomicWithdrawal(input);
  assert.equal(replay.withdrawal.id, first.withdrawal.id);
  await assert.rejects(dbService.executeAtomicWithdrawal({ ...input, amount: 60000 }), /Idempotency/);
  assert.equal(db.withdrawals.filter(w => w.idempotencyKey === input.idempotencyKey).length, 1);
  await dbService.archiveWithdrawal(first.withdrawal.id, user);
  await dbService.archiveWithdrawal(first.withdrawal.id, user);
  const archivedReplay = await dbService.executeAtomicWithdrawal(input);
  assert.equal(archivedReplay.withdrawal.id, first.withdrawal.id);
  assert.equal(archivedReplay.withdrawal.status, 'rejected');
  assert.ok(archivedReplay.withdrawal.archivedAt);
  assert.equal(db.ledger.filter(e => e.refId === 'withdraw_refund_' + first.withdrawal.id).length, 1);
  const { queryWithdrawalsPaginated } = require('../src/repositories/postgresRepository');
  assert.ok(!queryWithdrawalsPaginated(db).items.some(w => w.id === first.withdrawal.id));
  console.log('PASS: spoofed IP, legacy forged token, bootstrap credentials, durable replay and conflicting payload');
})().catch(err => { console.error(err); process.exitCode = 1; });
