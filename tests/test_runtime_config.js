process.env.NODE_ENV = 'test';
const assert = require('assert/strict');
const { getRedisConfig, inspectProductionConfig } = require('../src/utils/runtimeConfig');
const { createRateLimiter } = require('../src/utils/securityMiddleware');

(async () => {
  const valid = { JWT_SECRET: 'x'.repeat(48), ADMIN_PASSWORD: 'fixture-long-password', DATABASE_URL: 'postgresql://user:password@localhost/test', KV_REST_API_URL: 'https://fixture.upstash.io', KV_REST_API_TOKEN: 'fixture-token' };
  assert.equal(inspectProductionConfig(valid).some(c => c.status === 'FAIL'), false);
  for (const key of ['JWT_SECRET', 'ADMIN_PASSWORD', 'DATABASE_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) {
    const env = { ...valid }; delete env[key];
    assert.ok(inspectProductionConfig(env).some(c => c.status === 'FAIL'), key);
  }
  assert.equal(getRedisConfig({ ...valid, UPSTASH_REDIS_REST_URL: 'https://other.upstash.io' }).token, '');
  assert.ok(inspectProductionConfig({ ...valid, TURNSTILE_SECRET_KEY: 'secret-only' }).some(c => c.name === 'turnstile' && c.status === 'FAIL'));
  assert.ok(!JSON.stringify(inspectProductionConfig(valid)).includes(valid.KV_REST_API_TOKEN));
  assert.equal(inspectProductionConfig({ ...valid, JWT_SECRET: '[sensitive]' }).find(c => c.name === 'auth').status, 'NOT_TESTED');
  const oldFetch = global.fetch;
  const keys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'VERCEL'];
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.KV_REST_API_URL = valid.KV_REST_API_URL;
    process.env.KV_REST_API_TOKEN = valid.KV_REST_API_TOKEN;
    process.env.VERCEL = '1';
    const limiter = createRateLimiter({ max: 1, failClosed: true });
    let count = 0, passed = 0, status;
    global.fetch = async (url, options) => {
      assert.equal(url, valid.KV_REST_API_URL + '/pipeline');
      assert.equal(options.headers.Authorization, 'Bearer ' + valid.KV_REST_API_TOKEN);
      return { ok: true, json: async () => [{ result: ++count }, { result: 1 }] };
    };
    const req = { ip: '127.0.0.1' }, res = { status(code) { status = code; return this; }, json() {} };
    await limiter(req, res, () => passed++);
    await limiter(req, res, () => passed++);
    assert.equal(passed, 1); assert.equal(status, 429);
    global.fetch = async () => { throw new Error('network failure'); };
    await limiter(req, res, () => passed++);
    assert.equal(status, 503); assert.equal(passed, 1);
    process.env.UPSTASH_REDIS_REST_URL = 'https://other.upstash.io';
    await limiter(req, res, () => passed++);
    assert.equal(status, 503); assert.equal(passed, 1);
  } finally {
    global.fetch = oldFetch;
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  }
  console.log('PASS: startup requirements, paired Redis aliases, fail-closed errors, quota enforcement and secret-free output');
})().catch(error => { console.error(error); process.exitCode = 1; });
