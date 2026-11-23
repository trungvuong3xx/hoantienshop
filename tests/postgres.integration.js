process.env.NODE_ENV = 'test';
const assert = require('assert/strict');
const { fork } = require('child_process');
const { Pool } = require('pg');
if (process.env.AFF_PG_WORKER === '1') {
  const d = require('../src/services/dbService');
  process.env.POSTBACK_SECRET = 'integration-webhook-only';
  let server;
  (async () => { await d.initPostgresIfConfigured(); process.send({ ready: true }); })().catch(e => { process.send({ error: e.message }); process.exitCode = 1; });
  process.on('message', async ({ id, action, input }) => {
    try {
      let result;
      if (action === 'stop') { if (server) await new Promise(r => server.close(r)); await d.getPgPool().end(); process.disconnect(); return; }
      if (action === 'seed') { const db = d.ensureDbLoaded(); d.appendLedgerEntry(db.users[0].id, 'admin_adjustment', 500000, 'integration-credit'); await d.saveDb(db); result = true; }
      if (action === 'http') { server = require('../server').listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); result = { port: server.address().port, token: d.createToken(d.ensureDbLoaded().users.find(u => u.role === 'admin')) }; }
      if (action === 'paid') result = await d.settleWithdrawal(input, 'paid', { id: 'integration-admin' });
      if (action === 'archive') result = await d.archiveWithdrawal(input, { id: 'integration-admin' });
      if (action === 'refund') { const db = d.ensureDbLoaded(); result = await d.refundWithdrawal(db, db.withdrawals.find(w => w.id === input)); }
      if (action === 'clicks') { const db = d.ensureDbLoaded(); db.clicks = Array.from({ length: 6001 }, (_, i) => ({ clickId: 'click_' + i, createdAt: new Date().toISOString() })); await d.saveDb(db); await d.reloadStateFromPostgres(); result = db.clicks.length; }
      if (action === 'appendClick') { await d.appendClickRecords([input]); result = true; }
      if (action === 'findClick') result = await d.findClickById(input);
      if (action === 'cachedClick') result = d.ensureDbLoaded().clicks.some(c => c.clickId === input);
      if (action === 'cachedLedger') result = d.ensureDbLoaded().ledger.filter(e => e.note === input).length;
      if (action === 'claimBatch') {
        const db = d.ensureDbLoaded();
        db.orders.push(...input);
        await d.saveDb(db); await d.reloadStateFromPostgres();
        result = db.orders.filter(o => input.some(i => i.orderSn === o.orderSn));
      }
      if (action === 'claimSingle') {
        await d.persistOrderToPostgres(input); await d.reloadStateFromPostgres();
        result = d.ensureDbLoaded().orders.find(o => o.orderSn === input.orderSn);
      }
      if (action === 'reload') { await d.reloadStateFromPostgres(); result = true; }
      if (action === 'preservation') {
        await d.reloadStateFromPostgres({ strict: true });
        const db = d.ensureDbLoaded();
        db.orders = []; db.withdrawals = []; db.users = [];
        await d.saveDb(db);
        await d.reloadStateFromPostgres({ strict: true });
        result = true;
      }
      if (action === 'datedUser') {
        const db = d.ensureDbLoaded();
        const u = { id: 'dated-user', code: 'DATED', phone: '0900000009', role: 'user', passwordHash: d.hashPassword('Fixture!123'), createdAt: '2020-01-02T00:00:00.000Z' };
        db.users.push(u); await d.saveDb(db);
        await d.persistUserToPostgres({ ...u, name: 'Updated', createdAt: '2021-01-01T00:00:00.000Z' });
        await d.reloadStateFromPostgres(); result = true;
      }
      if (action === 'save') { const db = d.ensureDbLoaded(); db.settings.siteName = input; await d.saveDb(db); result = true; }
      if (action === 'saveDirtyOrder') { const db = d.ensureDbLoaded(); db.orders.push({ orderSn: 'must-not-survive', platform: 'shopee', status: 'pending' }); await d.saveDb(db); result = true; }
      if (action === 'withdraw') result = await d.executeAtomicWithdrawal({ userId: 'usr_admin', amount: 50000, bankName: 'MB', bankAccount: '12345678', bankOwner: 'TEST USER', minWithdraw: 50000, ...input });
      process.send({ id, result });
    } catch (e) { process.send({ id, error: e.message, code: e.code }); }
  });
} else {
  (async () => {
    const url = new URL(process.env.PG_TEST_URL || '');
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Integration tests require an explicit localhost PostgreSQL URL');
    const database = 'aff_integration_' + Date.now();
    const admin = new Pool({ connectionString: url.toString() });
    const children = [];
    let check;
    try {
      await admin.query('CREATE DATABASE ' + database);
      url.pathname = '/' + database;
      check = new Pool({ connectionString: url.toString() });
      const start = () => new Promise((resolve, reject) => {
        const child = fork(__filename, [], { env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].includes(key.toUpperCase()))), NODE_ENV: 'test', TEST_DATABASE_URL: url.toString(), AFF_PG_WORKER: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        children.push(child); let errorText = ''; child.stderr.on('data', b => errorText += b);
        child.once('message', msg => msg.ready ? resolve(child) : reject(new Error(msg.error)));
        child.once('error', reject); child.once('exit', code => { if (code) reject(new Error(errorText)); });
      });
      let seq = 0;
      const call = (child, action, input) => new Promise((resolve, reject) => {
        const id = ++seq; const timer = setTimeout(() => { child.off('message', receive); reject(new Error('Worker timeout')); }, 25000);
        function receive(msg) { if (msg.id !== id) return; clearTimeout(timer); child.off('message', receive); resolve(msg); }
        child.on('message', receive); child.send({ id, action, input });
      });
      const a = await start(); assert.equal((await call(a, 'seed')).error, undefined);
      await check.query("INSERT INTO orders(order_sn,platform,user_code,status) VALUES('PRESERVE','shopee','GUEST','pending')");
      for (const status of ['pending','paid','rejected']) {
        await check.query('INSERT INTO withdrawals(id,user_id,amount,status) VALUES($1,$2,50000,$3)', ['preserve-' + status, 'usr_admin', status]);
      }
      assert.equal((await call(a, 'preservation')).error, undefined);
      assert.equal(Number((await check.query("SELECT count(*) FROM orders WHERE order_sn='PRESERVE'")).rows[0].count), 1);
      assert.equal(Number((await check.query("SELECT count(*) FROM withdrawals WHERE id LIKE 'preserve-%'")).rows[0].count), 3);
      assert.equal(Number((await check.query("SELECT count(*) FROM users WHERE id='usr_admin'")).rows[0].count), 1);
      assert.equal((await call(a, 'datedUser')).error, undefined);
      assert.equal((await check.query("SELECT created_at FROM users WHERE id='dated-user'")).rows[0].created_at.toISOString(), '2020-01-02T00:00:00.000Z');
      // Fixtures have served their purpose; remove only their non-financial rows in this disposable DB.
      await check.query("DELETE FROM withdrawals WHERE id LIKE 'preserve-%'");
      await check.query("DELETE FROM orders WHERE order_sn='PRESERVE'");
      await call(a, 'reload');
      console.log('PASS: sparse snapshots preserve users/orders/all withdrawal statuses; user creation date survives update');
      const b = await start();
      assert.equal((await call(a, 'save', 'winner')).error, undefined);
      assert.equal((await call(b, 'save', 'loser')).code, 'STATE_CONFLICT');
      assert.equal((await check.query("SELECT payload->'settings'->>'siteName' AS name FROM hoantienshop_state")).rows[0].name, 'winner');
      console.log('PASS: stale write rejected without silently dropping mutation');
      await call(a, 'reload'); await call(b, 'reload');
      const [w1, w2] = await Promise.all([call(a, 'withdraw', { idempotencyKey: 'same-key' }), call(b, 'withdraw', { idempotencyKey: 'same-key' })]);
      assert.equal(w1.error, undefined); assert.equal(w2.error, undefined);
      assert.equal(w1.result.withdrawal.id, w2.result.withdrawal.id);
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM withdrawals')).rows[0].count), 1);
      assert.equal(Number((await check.query("SELECT SUM(amount) AS balance FROM ledger WHERE user_id='usr_admin'")).rows[0].balance), 450000);
      console.log('PASS: two processes, one idempotency key, one withdrawal and one debit');
      await call(b, 'reload');
      assert.equal((await call(a, 'withdraw', { idempotencyKey: 'second-key' })).error, undefined);
      assert.equal((await call(b, 'save', 'stale-after-withdrawal')).code, 'STATE_CONFLICT');
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM withdrawals')).rows[0].count), 2);
      console.log('PASS: stale snapshot cannot delete a newly committed withdrawal');
      await call(a, 'reload'); await call(b, 'reload');
      assert.equal((await call(a, 'paid', w1.result.withdrawal.id)).error, undefined);
      assert.equal((await call(b, 'refund', w1.result.withdrawal.id)).code, 'WITHDRAWAL_CONFLICT');
      assert.equal(Number((await check.query("SELECT COUNT(*) FROM ledger WHERE type = 'withdrawal_refund'")).rows[0].count), 0);
      assert.equal((await check.query('SELECT status FROM withdrawals WHERE id=$1', [w1.result.withdrawal.id])).rows[0].status, 'paid');
      console.log('PASS: stale refund after paid rolls back both status and ledger');
      await call(a, 'reload');
      assert.equal((await call(a, 'clicks')).result, 6001);
      console.log('PASS: 6001 recent clicks survive PostgreSQL save and reload');
      const http = (await call(a, 'http')).result;
      await check.query("INSERT INTO orders(order_sn,platform,user_code,status) VALUES('EXPLICIT_DELETE','shopee','GUEST','pending')");
      await call(a, 'reload');
      const deleteResponse = await fetch('http://127.0.0.1:' + http.port + '/api/admin/orders/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + http.token },
        body: JSON.stringify({ orderSn: 'EXPLICIT_DELETE', platform: 'shopee' })
      });
      assert.equal(deleteResponse.status, 200, await deleteResponse.text());
      assert.equal(Number((await check.query("SELECT count(*) FROM orders WHERE order_sn='EXPLICIT_DELETE'")).rows[0].count), 0);
      assert.equal(Number((await check.query("SELECT count(*) FROM audit_logs WHERE action='delete_order' AND details->>'orderSn'='EXPLICIT_DELETE'")).rows[0].count), 1);
      console.log('PASS: explicit admin deletion persists with audit');
      const postOrder = (route, body) => fetch('http://127.0.0.1:' + http.port + route, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + http.token }, body: JSON.stringify(body)
      });
      const creditedOrder = await postOrder('/api/admin/orders', {orderSn:'DELETE_CREDIT',platform:'shopee',userCode:'DATED',totalCommission:10000,status:'approved'});
      assert.equal(creditedOrder.status,200,await creditedOrder.text());
      const creditRows = (await check.query("SELECT id,amount FROM ledger WHERE user_id='dated-user' ORDER BY id")).rows;
      assert.ok(creditRows.some(row => Number(row.amount)>0));
      assert.equal((await postOrder('/api/admin/orders/delete',{orderSn:'DELETE_CREDIT',platform:'shopee'})).status,200);
      const reverted = (await check.query("SELECT id,amount FROM ledger WHERE user_id='dated-user' ORDER BY id")).rows;
      assert.equal(reverted.reduce((sum,row)=>sum+Number(row.amount),0),0);
      for (const row of creditRows) assert.ok(reverted.some(other=>other.id===row.id && other.amount===row.amount));
      assert.equal((await postOrder('/api/admin/orders/delete',{orderSn:'DELETE_CREDIT',platform:'shopee'})).status,404);
      assert.deepEqual((await check.query("SELECT id,amount FROM ledger WHERE user_id='dated-user' ORDER BY id")).rows,reverted);
      console.log('PASS: deleting credited order appends reversal, preserves ledger and retry cannot reverse twice');
      const endpoint = 'http://127.0.0.1:' + http.port + '/api/admin/settings';
      const headers = { Authorization: 'Bearer ' + http.token };
      assert.equal((await fetch(endpoint, { headers })).status, 200);
      await check.query("UPDATE users SET token_version = token_version + 1 WHERE id='usr_admin'");
      assert.equal((await fetch(endpoint, { headers })).status, 403);
      console.log('PASS: revoked database token denied despite stale instance cache');
      await call(a, 'reload'); await call(b, 'reload');
      const version = (await check.query('SELECT version FROM hoantienshop_state')).rows[0].version;
      const click = { clickId: 'incremental-click', affiliateUrl: 'https://shopee.vn/product/123/456', createdAt: new Date().toISOString() };
      assert.equal((await call(a, 'appendClick', click)).error, undefined);
      assert.equal((await call(a, 'appendClick', click)).error, undefined);
      assert.equal((await check.query('SELECT version FROM hoantienshop_state')).rows[0].version, version);
      assert.equal((await call(b, 'findClick', click.clickId)).result.affiliateUrl, click.affiliateUrl);
      assert.equal((await call(b, 'save', 'snapshot-after-insert')).error, undefined);
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM clicks WHERE click_id=$1', [click.clickId])).rows[0].count), 1);
      console.log('PASS: incremental click is replay-safe, visible cross-instance, preserved by older snapshot');
      await check.query("CREATE FUNCTION reject_fixture_click() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.click_id = 'fail-click' THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_fixture BEFORE INSERT ON clicks FOR EACH ROW EXECUTE FUNCTION reject_fixture_click();");
      assert.ok((await call(a, 'appendClick', { ...click, clickId: 'fail-click' })).error);
      assert.equal((await call(a, 'cachedClick', 'fail-click')).result, false);
      assert.equal(Number((await check.query("SELECT COUNT(*) FROM clicks WHERE click_id='fail-click'")).rows[0].count), 0);
      console.log('PASS: failed database insert does not publish a phantom click to cache');
      const attributed = { ...click, clickId: 'aabbccddeeff0011', userId: 'usr_admin', userCode: 'TRUNGVUONG3X' };
      assert.equal((await call(a, 'appendClick', attributed)).error, undefined);
      const otherHttp = (await call(b, 'http')).result;
      const postback = await fetch('http://127.0.0.1:' + otherHttp.port + '/api/webhooks/postback', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-postback-token': 'integration-webhook-only' },
        body: JSON.stringify({ orderSn: 'CROSS-INSTANCE-ORDER', clickId: attributed.clickId, grossCommission: 10000, status: 'pending', platform: 'shopee' })
      });
      assert.equal(postback.status, 200);
      assert.equal((await check.query("SELECT user_id FROM orders WHERE order_sn='CROSS-INSTANCE-ORDER'")).rows[0].user_id, 'usr_admin');
      console.log('PASS: webhook on another instance attributes newly inserted click to its owner');
      await call(a, 'reload'); await call(b, 'reload');
      const racing = await call(a, 'withdraw', { idempotencyKey: 'settlement-race' });
      assert.equal(racing.error, undefined);
      const raceId = racing.result.withdrawal.id;
      await call(b, 'reload');
      const transitions = await Promise.all([call(a, 'paid', raceId), call(b, 'refund', raceId)]);
      assert.equal(transitions.filter(r => !r.error).length, 1);
      const settled = (await check.query('SELECT status FROM withdrawals WHERE id=$1', [raceId])).rows[0].status;
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM ledger WHERE ref_id=$1', ['withdraw_refund_' + raceId])).rows[0].count), settled === 'rejected' ? 1 : 0);
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM audit_logs WHERE target_id=$1 AND action=$2', [raceId, 'update_withdrawal'])).rows[0].count), 1);
      console.log('PASS: competing paid/refund transitions produce one terminal state and one atomic audit');
      const fault = await call(a, 'withdraw', { idempotencyKey: 'audit-rollback' });
      assert.equal(fault.error, undefined);
      const faultId = fault.result.withdrawal.id;
      const beforeBalance = (await check.query("SELECT balance_available FROM users WHERE id='usr_admin'")).rows[0].balance_available;
      await check.query("CREATE FUNCTION reject_fixture_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit fixture failure'; END $$; CREATE TRIGGER reject_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_fixture_audit();");
      assert.ok((await call(a, 'refund', faultId)).error);
      assert.equal((await check.query('SELECT status FROM withdrawals WHERE id=$1', [faultId])).rows[0].status, 'pending');
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM ledger WHERE ref_id=$1', ['withdraw_refund_' + faultId])).rows[0].count), 0);
      assert.equal((await check.query("SELECT balance_available FROM users WHERE id='usr_admin'")).rows[0].balance_available, beforeBalance);
      await check.query('DROP TRIGGER reject_audit ON audit_logs');
      assert.equal((await call(a, 'refund', faultId)).error, undefined);
      await call(b, 'reload');
      assert.equal((await call(b, 'refund', faultId)).error, undefined);
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM audit_logs WHERE target_id=$1', [faultId])).rows[0].count), 1);
      console.log('PASS: audit failure rolls back refund, status and balance; replay creates no duplicate audit');
      await call(b, 'reload');
      const adjustment = await fetch('http://127.0.0.1:' + otherHttp.port + '/api/admin/users/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + otherHttp.token },
        body: JSON.stringify({ action: 'adjust_balance', userId: 'usr_admin', amount: 123, note: 'durable-audit-fixture' })
      });
      assert.equal(adjustment.status, 200);
      assert.equal(Number((await check.query("SELECT COUNT(*) FROM audit_logs WHERE action='adjust_balance' AND details->>'note'='durable-audit-fixture'")).rows[0].count), 1);
      assert.equal(Number((await check.query("SELECT COUNT(*) FROM ledger WHERE type='admin_adjustment' AND amount=123")).rows[0].count), 1);
      console.log('PASS: admin adjustment HTTP response includes durable ledger and audit in the same save');
      const corrupt = await call(a, 'withdraw', { idempotencyKey: 'mismatched-reservation' });
      assert.equal(corrupt.error, undefined);
      const corruptId = corrupt.result.withdrawal.id;
      await check.query('UPDATE withdrawals SET amount=amount+1 WHERE id=$1', [corruptId]);
      assert.equal((await call(a, 'paid', corruptId)).code, 'WITHDRAWAL_INTEGRITY');
      assert.equal((await call(a, 'refund', corruptId)).code, 'WITHDRAWAL_INTEGRITY');
      assert.equal((await check.query('SELECT status FROM withdrawals WHERE id=$1', [corruptId])).rows[0].status, 'pending');
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM ledger WHERE ref_id=$1', ['withdraw_refund_' + corruptId])).rows[0].count), 0);
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM audit_logs WHERE target_id=$1', [corruptId])).rows[0].count), 0);
      console.log('PASS: mismatched reservation blocks both payment and refund without changing financial state');
      const archiveCandidate = await call(a, 'withdraw', { idempotencyKey: 'archive-replay' });
      assert.equal(archiveCandidate.error, undefined);
      const archiveId = archiveCandidate.result.withdrawal.id;
      await call(b, 'reload');
      await check.query('CREATE TRIGGER reject_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_fixture_audit()');
      assert.ok((await call(a, 'archive', archiveId)).error);
      const failedArchive = (await check.query('SELECT status, archived_at FROM withdrawals WHERE id=$1', [archiveId])).rows[0];
      assert.equal(failedArchive.status, 'pending'); assert.equal(failedArchive.archived_at, null);
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM ledger WHERE ref_id=$1', ['withdraw_refund_' + archiveId])).rows[0].count), 0);
      await check.query('DROP TRIGGER reject_audit ON audit_logs');
      const deleted = await fetch('http://127.0.0.1:' + otherHttp.port + '/api/admin/withdrawals/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + otherHttp.token },
        body: JSON.stringify({ id: archiveId, hardDelete: true })
      });
      assert.equal(deleted.status, 200); assert.equal((await deleted.json()).archived, true);
      assert.equal((await call(a, 'archive', archiveId)).error, undefined);
      const replayArchived = await call(a, 'withdraw', { idempotencyKey: 'archive-replay' });
      assert.equal(replayArchived.error, undefined);
      assert.equal(replayArchived.result.withdrawal.id, archiveId);
      assert.equal(replayArchived.result.withdrawal.status, 'rejected');
      assert.ok((await call(a, 'withdraw', { idempotencyKey: 'archive-replay', amount: 60000 })).error);
      assert.equal(Number((await check.query('SELECT COUNT(*) FROM ledger WHERE ref_id=$1', ['withdraw_refund_' + archiveId])).rows[0].count), 1);
      assert.equal(Number((await check.query("SELECT COUNT(*) FROM audit_logs WHERE target_id=$1 AND action='archive_withdrawal'", [archiveId])).rows[0].count), 1);
      const list = await fetch('http://127.0.0.1:' + otherHttp.port + '/api/admin/withdrawals', { headers: { Authorization: 'Bearer ' + otherHttp.token } });
      assert.equal(list.status, 200); assert.ok(!(await list.json()).withdrawals.some(w => w.id === archiveId));
      await call(a, 'reload');
      assert.equal((await call(a, 'save', 'after-archive')).error, undefined);
      assert.ok((await check.query('SELECT archived_at FROM withdrawals WHERE id=$1', [archiveId])).rows[0].archived_at);
      assert.equal((await call(a, 'archive', w1.result.withdrawal.id)).code, 'WITHDRAWAL_CONFLICT');
      console.log('PASS: atomic archive/refund, audit rollback, durable replay, hidden listings and snapshot preservation');
      await call(b, 'reload');
      await check.query('CREATE TRIGGER reject_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_fixture_audit()');
      const failedAdjustment = await fetch('http://127.0.0.1:' + otherHttp.port + '/api/admin/users/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + otherHttp.token },
        body: JSON.stringify({ action: 'adjust_balance', userId: 'usr_admin', amount: 777, note: 'failed-adjustment-must-not-return' })
      });
      assert.equal(failedAdjustment.status, 500);
      assert.equal((await call(b, 'cachedLedger', 'failed-adjustment-must-not-return')).result, 0);
      await check.query('DROP TRIGGER reject_audit ON audit_logs');
      assert.equal((await call(b, 'save', 'after-failed-adjustment')).error, undefined);
      assert.equal(Number((await check.query("SELECT COUNT(*) FROM ledger WHERE note='failed-adjustment-must-not-return'")).rows[0].count), 0);
      console.log('PASS: failed adjustment is discarded from cache and cannot return in a later save');
      await check.query('ALTER TABLE orders RENAME TO fixture_unavailable_orders');
      assert.ok((await call(b, 'saveDirtyOrder')).error);
      assert.equal((await call(b, 'cachedLedger', 'anything')).code, 'CACHE_UNAVAILABLE');
      assert.equal((await call(b, 'save', 'blocked-while-invalid')).code, 'CACHE_UNAVAILABLE');
      await check.query('ALTER TABLE fixture_unavailable_orders RENAME TO orders');
      assert.equal((await call(b, 'reload')).error, undefined);
      assert.equal((await call(b, 'save', 'recovered')).error, undefined);
      console.log('PASS: failed cache recovery blocks reads/writes until authoritative reload succeeds');
      const fixtures = [
        { orderSn: 'TEST_CLAIM_VERIFIED', status: 'pending', claimVerified: true, claimRejected: false },
        { orderSn: 'TEST_CLAIM_REJECTED', status: 'pending', claimVerified: false, claimRejected: true, claimRejectReason: 'Tài khoản nhận đơn không khớp.' }
      ];
      const roundtrip = await call(b, 'claimBatch', fixtures);
      assert.equal(roundtrip.error, undefined);
      for (const expected of fixtures) {
        const actual = roundtrip.result.find(o => o.orderSn === expected.orderSn);
        assert.equal(actual.claimVerified, expected.claimVerified);
        assert.equal(actual.claimRejected, expected.claimRejected);
        assert.equal(actual.claimRejectReason, expected.claimRejectReason || null);
      }
      const corrected = await call(b, 'claimSingle', { ...fixtures[1], claimVerified: true, claimRejected: false, claimRejectReason: null });
      assert.equal(corrected.error, undefined);
      assert.equal(corrected.result.claimVerified, true); assert.equal(corrected.result.claimRejected, false);
      assert.equal(corrected.result.claimRejectReason, null);
      console.log('PASS: claim flags/reason survive batch and single-row persistence and reload');
      const snapshot = async () => {
        const state = {};
        for (const table of ['users', 'orders', 'ledger', 'withdrawals', 'clicks', 'audit_logs', 'hoantienshop_state']) {
          state[table] = (await check.query(`SELECT row_to_json(t) AS row FROM ${table} t`)).rows.map(r => JSON.stringify(r.row)).sort();
        }
        return state;
      };
      const beforeInspection = await snapshot();
      const inspect = await fetch('http://127.0.0.1:' + otherHttp.port + '/api/admin/cleanup-test-data', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + otherHttp.token }, body: '{}'
      });
      assert.equal(inspect.status, 200);
      const report = await inspect.json(); assert.equal(report.previewOnly, true);
      assert.ok(report.candidates.orderSns.includes(fixtures[0].orderSn));
      assert.deepEqual(await snapshot(), beforeInspection);
      console.log('PASS: legacy cleanup endpoint reports candidates without changing any persisted data');
      await assert.rejects(check.query("DELETE FROM ledger WHERE ref_id='integration-credit'"));
      assert.equal(Number((await check.query("SELECT COUNT(*) FROM ledger WHERE ref_id='integration-credit'")).rows[0].count), 1);
      console.log('PASS: ledger delete protection remains active after inspection');
    } finally {
      await Promise.all(children.map(child => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.send({ action: 'stop' }); })));
      if (check) await check.end();
      await admin.query('DROP DATABASE IF EXISTS ' + database);
      await admin.end();
    }
  })().catch(e => { console.error(e); process.exitCode = 1; });
}
