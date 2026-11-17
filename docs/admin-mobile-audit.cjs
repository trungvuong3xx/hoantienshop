const { chromium } = require('playwright');
const express = require('express');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
(async () => {
  const out = path.join(__dirname, 'admin-mobile-audit'); fs.mkdirSync(out, { recursive: true });
  const app = express(); app.use(express.static(path.join(__dirname, '../public')));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
    const results = [];
    for (const width of [320, 360, 390, 430, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
      const origin = `http://127.0.0.1:${server.address().port}`;
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', r => r.request().url() === origin + '/api/public-config' ? r.fulfill({json:{settings:{}}}) : r.request().url().startsWith(origin) && !r.request().url().includes('/api/') ? r.continue() : r.abort());
      await page.goto(origin);
      await page.evaluate(() => {
        document.querySelectorAll('.view-section').forEach(e => e.classList.remove('active'));
        document.getElementById('view-admin').classList.add('active');
        document.getElementById('mobileNavAdminBtn').classList.remove('hidden');
        renderAdminOrdersTable([{id:'fixture',orderSn:'261117ABCDEFGHI',userCode:'KH000123',productName:'Bộ sản phẩm chăm sóc gia đình phiên bản đặc biệt',grossCommission:150000,userCashbackAmount:94500,status:'pending',createdAt:'2026-11-17'}]);
        renderAdminUsersTable([{id:'fixture',code:'KH000123',name:'Nguyễn Thị Minh Anh',phone:'0900000123',balanceAvailable:1500000,balancePending:250000}]);
        renderAdminWithdrawalsTable([{id:'fixture',userCode:'KH000123',amount:1500000,bankName:'Vietcombank',bankAccount:'0123456789012',bankOwner:'NGUYEN THI MINH ANH',status:'pending',createdAt:'2026-11-17',vietQrUrl:'https://example.invalid/fixture.png'}]);
      });
      await page.waitForTimeout(700);
      for (const tab of ['orders','withdrawals','users','settings']) {
        await page.evaluate(t => { switchAdminTab(t); window.scrollTo(0,0); }, tab);
        await page.waitForTimeout(200);
        results.push(await page.evaluate(({width,tab}) => {
          const pane = document.querySelector('.admin-tab-pane.active');
          const table = pane.querySelector('.table-responsive');
          const nav = document.querySelector('.admin-tabs-nav');
          return {width,tab,pageWidth:document.documentElement.scrollWidth,tabTop:Math.round(nav.getBoundingClientRect().top),navWidth:nav.clientWidth,navScrollWidth:nav.scrollWidth,tableWidth:table?.clientWidth,tableScrollWidth:table?.scrollWidth,smallTargets:[...document.querySelectorAll('#view-admin button')].filter(e=>e.getClientRects().length && (e.getBoundingClientRect().height<44 || e.getBoundingClientRect().width<44)).map(e=>({text:e.textContent.trim(),height:Math.round(e.getBoundingClientRect().height)}))};
        }, {width,tab}));
        const measured = results.at(-1);
        assert.equal(measured.pageWidth, width, `Page overflow: ${width}/${tab}`);
        if (width <= 640) {
          assert.equal(measured.navWidth, measured.navScrollWidth, 'Tabs must fit');
          assert.ok(measured.tabTop < 400, 'Tabs must be reachable on first screen');
          if (measured.tableWidth) assert.equal(measured.tableWidth, measured.tableScrollWidth, 'Cards must fit');
          assert.equal(measured.smallTargets.length, 0, 'Buttons must be touch sized');
        }
        if(width===360) await page.screenshot({path:path.join(out,`${tab}-360.png`),fullPage:true});
      }
      for(const id of ['userManageModal','orderEditModal']) {
        await page.evaluate(id=>document.getElementById(id).classList.remove('hidden'),id);
        await page.waitForTimeout(300);
        results.push(await page.evaluate(({width,id})=>{const e=document.querySelector(`#${id} .modal-box`);return {width,modal:id,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,amountWidth:id==='userManageModal'?document.getElementById('manageAdjustAmount').getBoundingClientRect().width:null};},{width,id}));
        assert.equal(results.at(-1).clientWidth, results.at(-1).scrollWidth, 'Modal must fit');
        if (id === 'userManageModal') {
          assert.ok(results.at(-1).amountWidth >= 150, 'Amount input must be readable');
          await page.locator('#manageAdjustAmount').fill('123456789012');
          await page.locator('#manageAdjustTypeChoice').click();
          await page.getByRole('button', {name:'Trừ (-)', exact:true}).click();
          assert.match(await page.locator('.admin-adjust-preview').textContent(), /Trừ/);
        }
        if(width===360) await page.screenshot({path:path.join(out,`${id}-360.png`)});
        await page.evaluate(id=>document.getElementById(id).classList.add('hidden'),id);
      }
      await page.evaluate(() => switchAdminTab('orders'));
      const edit = page.locator('[data-ord-action="edit"]');
      if (width <= 640) {
        assert.equal(await edit.isVisible(), false);
        await page.locator('#admOrdersTableBody summary').click();
      }
      assert.equal(await edit.isVisible(), true, 'Secondary actions must remain reachable');
      await page.evaluate(() => {
        latestAdminOrders = [{id:'fixture',orderSn:'261117ABCDEFGHI',userCode:'KH000123',status:'pending',grossCommission:150000,userCashbackAmount:94500}];
        latestAdminUsers = [{id:'fixture',code:'KH000123',name:'Nguyễn Thị Minh Anh',balanceAvailable:1500000}];
        latestAdminWithdrawals = [{id:'fixture',amount:1500000,bankName:'Vietcombank',bankAccount:'0123456789012',bankOwner:'NGUYEN THI MINH ANH'}];
      });
      await edit.click();
      await page.locator('#orderEditModal').waitFor({state:'visible'});
      assert.equal(await page.locator('#editOrdSn').inputValue(), '261117ABCDEFGHI');
      await page.locator('#closeOrderEditModalBtn').click();
      await page.evaluate(() => switchAdminTab('users'));
      await page.locator('[data-manage-user]').click();
      await page.locator('#userManageModal').waitFor({state:'visible'});
      assert.match(await page.locator('#manageUserName').textContent(), /Minh Anh/);
      await page.locator('#closeUserManageModalBtn').click();
      await page.evaluate(() => switchAdminTab('withdrawals'));
      await page.locator('[data-wd-action="paid"]').click();
      await page.locator('#confirmActionModal').waitFor({state:'visible'});
      assert.match(await page.locator('#confirmActionModal').textContent(), /0123456789012/);
      await page.locator('#confirmModalCancelBtn').click();
      await page.evaluate(() => switchAdminTab('settings'));
      await page.locator('#admMinWithdraw').fill('60000');
      assert.match(await page.locator('.save-bar-hint').textContent(), /chưa lưu/);
      assert.deepEqual(errors, [], 'No browser runtime errors');
      await page.close();
    }
    // The amount field must remain usable without optional admin assets.
    for (const width of [360, 718, 1440]) {
      const page = await browser.newPage({viewport:{width,height:800}});
      const origin = `http://127.0.0.1:${server.address().port}`;
      await page.route('**/*', r => r.request().url().includes('/adminMobile.') ? r.abort() : r.request().url() === origin + '/api/public-config' ? r.fulfill({json:{settings:{}}}) : r.request().url().startsWith(origin) && !r.request().url().includes('/api/') ? r.continue() : r.abort());
      await page.goto(origin);
      await page.evaluate(() => document.getElementById('userManageModal').classList.remove('hidden'));
      await page.locator('#manageAdjustAmount').fill('123456789012');
      const amountWidth = await page.locator('#manageAdjustAmount').evaluate(e => e.getBoundingClientRect().width);
      assert.ok(amountWidth >= 200, `Amount shrank without enhancement at ${width}: ${amountWidth}`);
      assert.equal(await page.locator('label[for="manageAdjustAmount"]').count(), 1);
      await page.locator('#manageAdjustTypeChoice').click();
      await page.getByRole('button', {name:'Trừ (-)',exact:true}).click();
      assert.equal(await page.locator('#manageAdjustType').inputValue(), 'minus');
      if(width === 718) await page.screenshot({path:path.join(out,'amount-fallback-718.png')});
      results.push({width,enhancementBlocked:true,amountWidth});
      await page.close();
    }
    fs.writeFileSync(path.join(out,'measurements.json'),JSON.stringify(results,null,2)); console.log(JSON.stringify(results));
  } finally { if(browser) await browser.close(); await new Promise(r=>server.close(r)); }
})().catch(e=>{console.error(e);process.exitCode=1;});
