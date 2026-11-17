// Public, read-only production probes: no login, conversion, or financial mutations.
async function run() {
  const origin = new URL(process.argv[2]);
  if (origin.username || origin.password || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) throw new Error('Use HTTPS or localhost HTTP.');
  const checks = [];
  for (const route of ['/', '/api/health', '/api/public-config', '/selectPopup.js', '/selectPopup.css']) {
    const started = Date.now();
    try {
      const response = await fetch(new URL(route, origin.origin), { signal: AbortSignal.timeout(15000), redirect: 'error' });
      const body = await response.text();
      let valid = response.status === 200;
      if (route === '/api/health') { const data = JSON.parse(body); valid &&= data.status === 'ok' && data.database?.isPersistent === true; }
      else if (route === '/api/public-config') { const data = JSON.parse(body); valid &&= data !== null && typeof data === 'object' && !Array.isArray(data); }
      else if (route === '/') valid &&= body.includes('LiLa') && body.includes('app.js');
      else valid &&= !body.trimStart().startsWith('<');
      checks.push({ route, status: valid ? 'PASS' : 'FAIL', http: response.status, ms: Date.now() - started });
    } catch { checks.push({ route, status: 'FAIL', ms: Date.now() - started }); }
  }
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), checks }, null, 2));
  if (checks.some(c => c.status === 'FAIL')) process.exitCode = 1;
}
run().catch(() => { console.error('Usage: npm run check:production -- https://your-site'); process.exitCode = 1; });
