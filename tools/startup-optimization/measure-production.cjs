const { chromium } = require('../../node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const origin = 'https://hoantiensan.online';
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const rows = [];
  try {
    const probe = await browser.newContext();
    const sw = await (await probe.request.get(origin + '/sw.js')).text();
    const html = await (await probe.request.get(origin)).text();
    const version = { cache: sw.match(/const CACHE_NAME = '([^']+)'/)?.[1], app: html.match(/src="([^\"]*app\.js[^\"]*)"/)?.[1], nonblockingFont: html.includes('id="webFont"') };
    console.log('Production version:', JSON.stringify(version));
    await probe.close();
    for (const profile of ['current-network', 'simulated-mobile-4g']) {
      for (let sample = 1; sample <= 3; sample++) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
        await context.addInitScript(() => {
          window.__lcp = 0;
          new PerformanceObserver(list => { for (const e of list.getEntries()) window.__lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
        });
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        if (profile === 'simulated-mobile-4g') {
          await cdp.send('Network.enable');
          await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8, connectionType: 'cellular4g' });
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        }
        for (const visit of ['fresh', 'repeat']) {
          const errors = [];
          const onError = error => errors.push(error.message);
          page.on('pageerror', onError);
          const configDone = page.waitForResponse(r => r.url().includes('/api/public-config'), { timeout: 25000 }).then(async r => { await r.finished(); return r.status(); }).catch(() => null);
          const response = await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 45000 });
          const configStatus = await configDone;
          await page.waitForTimeout(1000);
          const metrics = await page.evaluate(() => {
            const nav = performance.getEntriesByType('navigation')[0];
            const resources = performance.getEntriesByType('resource');
            const config = resources.find(r => r.name.includes('/api/public-config'));
            return {
              ttfb: Math.round(nav.responseStart),
              fcp: Math.round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0),
              lcpObserved: Math.round(window.__lcp),
              domReady: Math.round(nav.domContentLoadedEventEnd),
              configReady: config ? Math.round(config.responseEnd) : null,
              configDuration: config ? Math.round(config.duration) : null,
              transferredBytes: resources.reduce((n,r) => n + r.transferSize, nav.transferSize),
              swControlled: Boolean(navigator.serviceWorker.controller),
              slowest: resources.sort((a,b) => b.duration-a.duration).slice(0,4).map(r => ({ url: r.name.split('?')[0], ms: Math.round(r.duration) }))
            };
          });
          const row = { profile, sample, visit, http: response.status(), configStatus, ...metrics, errors };
          rows.push(row);
          console.log(JSON.stringify(row));
          page.off('pageerror', onError);
          if (visit === 'fresh') await page.evaluate(async () => {
            await Promise.race([navigator.serviceWorker.ready, new Promise(resolve => setTimeout(resolve, 5000))]);
          });
        }
        await context.close();
      }
    }
    const summary = [];
    for (const profile of ['current-network', 'simulated-mobile-4g']) for (const visit of ['fresh', 'repeat']) {
      const group = rows.filter(r => r.profile === profile && r.visit === visit);
      summary.push({ profile, visit, ...Object.fromEntries(['ttfb','fcp','lcpObserved','domReady','configReady','configDuration','transferredBytes'].map(k => [k, median(group.map(r => r[k]))])) });
    }
    const report = { measuredAt: new Date().toISOString(), origin, version, methodology: '3 new browser contexts per profile; fresh and repeat visit each; mobile viewport; simulated 4G = 1.6 Mbps down, 750 Kbps up, 150ms latency, CPU x4 slowdown. LCP observed 1 second after config response; anonymous only.', summary, rows };
    fs.writeFileSync(path.join(__dirname, 'production-measurement.json'), JSON.stringify(report, null, 2));
    console.log('SUMMARY', JSON.stringify(summary));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
