// Keep platform aliases paired: never send a token to a different configured host.
function getRedisConfig(env = process.env) {
  const explicit = Boolean(env.UPSTASH_REDIS_REST_URL || env.UPSTASH_REDIS_REST_TOKEN);
  return {
    url: String(explicit ? env.UPSTASH_REDIS_REST_URL || '' : env.KV_REST_API_URL || '').trim(),
    token: String(explicit ? env.UPSTASH_REDIS_REST_TOKEN || '' : env.KV_REST_API_TOKEN || '').trim(),
    source: explicit ? 'UPSTASH' : 'KV'
  };
}

function inspectProductionConfig(env = process.env) {
  const checks = [];
  const add = (name, status, message) => checks.push({ name, status, message });
  const secret = (env.JWT_SECRET || env.AUTH_SECRET || '').trim();
  add('auth', secret.length >= 32 ? 'PASS' : 'FAIL', 'JWT_SECRET/AUTH_SECRET must contain at least 32 characters.');
  add('bootstrap', (env.ADMIN_PASSWORD || '').trim().length >= 6 ? 'PASS' : 'FAIL', 'ADMIN_PASSWORD is required for startup; minimum 6 characters.');
  let databaseValid = false;
  try { const url = new URL(env.DATABASE_URL); databaseValid = ['postgres:', 'postgresql:'].includes(url.protocol) && Boolean(url.hostname); } catch {}
  add('database', databaseValid ? 'PASS' : 'FAIL', 'DATABASE_URL must be a PostgreSQL connection URL.');
  const redis = getRedisConfig(env);
  let redisValid = false;
  try { const url = new URL(redis.url); redisValid = url.protocol === 'https:' && !url.username && !url.password && Boolean(redis.token); } catch {}
  add('redis', redisValid ? 'PASS' : 'FAIL', 'Configure a complete UPSTASH_REDIS_REST or KV_REST_API URL/token pair over HTTPS.');
  const site = Boolean(env.TURNSTILE_SITE_KEY?.trim()), turnstileSecret = Boolean(env.TURNSTILE_SECRET_KEY?.trim());
  add('turnstile', site && turnstileSecret ? 'PASS' : (site || turnstileSecret || env.REQUIRE_TURNSTILE === 'true' ? 'FAIL' : 'WARN'),
    'Configure both Turnstile keys; absent keys mean CAPTCHA is not verified from environment (DB settings require separate review).');
  add('cron', env.CRON_SECRET?.trim() ? 'PASS' : 'WARN', 'CRON_SECRET is required if scheduled synchronization is enabled.');
  const dependencies = {
    auth: [env.JWT_SECRET || env.AUTH_SECRET], bootstrap: [env.ADMIN_PASSWORD],
    database: [env.DATABASE_URL], redis: [redis.url, redis.token],
    turnstile: [env.TURNSTILE_SITE_KEY, env.TURNSTILE_SECRET_KEY], cron: [env.CRON_SECRET]
  };
  for (const check of checks) {
    if (dependencies[check.name].some(value => /^.{0,2}(redacted|sensitive|encrypted).{0,2}$/i.test(String(value || '').trim()))) {
      check.status = 'NOT_TESTED';
      check.message = 'Secret is masked by the export provider; validate in the deployment environment, not from this placeholder.';
    }
  }
  return checks;
}

module.exports = { getRedisConfig, inspectProductionConfig };
