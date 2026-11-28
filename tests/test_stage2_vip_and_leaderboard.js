if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}

const assert = require('assert');
const http = require('http');
const express = require('express');
const {
  initPostgresIfConfigured,
  reloadStateFromPostgres,
  ensureDbLoaded,
  saveDb,
  hashPassword,
  createToken,
  recalculateUserWallet,
  resolveUserCashbackRate
} = require('../src/services/dbService');
const {
  registerCashbackRoutes,
  upsertNetworkOrder
} = require('../src/services/cashbackController');

async function runTests() {
  await initPostgresIfConfigured();
  await reloadStateFromPostgres();

  const db = ensureDbLoaded();
  db.settings.cashbackPercent = 70;
  db.settings.taxDeductPercent = 10;

  const app = express();
  app.use(express.json());
  registerCashbackRoutes(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const suffix = Date.now();
  const adminUser = {
    id: `usr_adm_s2_${suffix}`,
    code: `ADMS2_${suffix}`,
    name: 'Admin S2',
    phone: `0997${suffix.toString().slice(-6)}`,
    passwordHash: hashPassword('AdminPass123!'),
    role: 'admin',
    tokenVersion: 1
  };
  const user1 = {
    id: `usr_1_s2_${suffix}`,
    code: `VIP1_${suffix}`,
    name: 'Nguyen Van An',
    phone: `0912${suffix.toString().slice(-6)}`,
    email: `an${suffix}@example.com`,
    passwordHash: hashPassword('UserPass123!'),
    role: 'user',
    tokenVersion: 1
  };
  const user2 = {
    id: `usr_2_s2_${suffix}`,
    code: `VIP2_${suffix}`,
    name: 'Tran Thi Binh',
    phone: `0934${suffix.toString().slice(-6)}`,
    email: `binh${suffix}@example.com`,
    passwordHash: hashPassword('UserPass123!'),
    role: 'user',
    tokenVersion: 1
  };
  db.users.push(adminUser, user1, user2);
  await saveDb(db);

  const adminToken = createToken(adminUser);
  const token1 = createToken(user1);

  const api = async (path, opts = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      }
    });
    const data = await res.json();
    return { status: res.status, data };
  };

  try {
    // 1. Admin VIP settings validation (reject non-ascending minSpend)
    const badRes = await api('/api/admin/settings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        vipTiersEnabled: true,
        vipTiers: [
          { code: 'bronze', name: 'Đồng', icon: '🥉', minSpend: 0, cashbackPercent: 70 },
          { code: 'silver', name: 'Bạc', icon: '🥈', minSpend: 0, cashbackPercent: 75 }
        ]
      })
    });
    assert.strictEqual(badRes.status, 400);

    // 2. Admin saves valid custom VIP table
    const okRes = await api('/api/admin/settings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        vipTiersEnabled: true,
        vipTiers: [
          { code: 'bronze', name: 'Thành viên Đồng', icon: '🥉', minSpend: 0, cashbackPercent: 70 },
          { code: 'silver', name: 'Thành viên Bạc', icon: '🥈', minSpend: 2000000, cashbackPercent: 75 },
          { code: 'gold', name: 'Thành viên Vàng', icon: '🥇', minSpend: 5000000, cashbackPercent: 80 }
        ]
      })
    });
    assert.strictEqual(okRes.status, 200);

    // 3. User1 starts Bronze (70%), gets approved order >= 2,000,000 -> upgrades to Silver (75%)
    const ord1 = upsertNetworkOrder(ensureDbLoaded(), {
      orderSn: `ORD_VIP_1_${suffix}`,
      rawSubId: user1.code,
      grossCommission: 100000,
      orderAmount: 2500000,
      status: 'approved',
      platform: 'shopee'
    });
    assert.strictEqual(ord1.lockedCashbackRate, 70);
    recalculateUserWallet(user1.id, { persist: false });
    await new Promise((r) => setTimeout(r, 40));

    const freshU1 = ensureDbLoaded().users.find((u) => u.id === user1.id);
    assert.strictEqual(freshU1.vipTier, 'silver');
    assert.strictEqual(freshU1.totalApprovedSpend, 2500000);
    assert.strictEqual(resolveUserCashbackRate(freshU1, ensureDbLoaded().settings), 75);

    // Next order uses Silver rate 75%
    const ord2 = upsertNetworkOrder(ensureDbLoaded(), {
      orderSn: `ORD_VIP_2_${suffix}`,
      rawSubId: user1.code,
      grossCommission: 100000,
      orderAmount: 500000,
      status: 'pending',
      platform: 'tiktok'
    });
    assert.strictEqual(ord2.lockedCashbackRate, 75);

    // Verify tier_upgrade notification created
    const notifRes = await api('/api/notifications', {
      headers: { Authorization: `Bearer ${token1}` }
    });
    assert(
      notifRes.data.items.some((n) => n.dedupeKey === `tier_up:${user1.id}:silver`),
      'Expected tier_upgrade notification for silver'
    );

    // 4. Custom Override takes priority over VIP tier (even if lower than Silver 75%)
    freshU1.customCashbackPercent = 65;
    assert.strictEqual(resolveUserCashbackRate(freshU1, ensureDbLoaded().settings), 65);
    freshU1.customCashbackPercent = null;

    // 5. Clawback: ord1 cancelled -> totalApprovedSpend drops to 0 -> vipTier downgrades back to bronze
    upsertNetworkOrder(ensureDbLoaded(), {
      orderSn: `ORD_VIP_1_${suffix}`,
      rawSubId: user1.code,
      grossCommission: 0,
      orderAmount: 2500000,
      status: 'cancelled',
      platform: 'shopee'
    });
    recalculateUserWallet(user1.id, { persist: false });
    const downgradedU1 = ensureDbLoaded().users.find((u) => u.id === user1.id);
    assert.strictEqual(downgradedU1.totalApprovedSpend, 0);
    assert.strictEqual(downgradedU1.vipTier, 'bronze');

    // 6. Leaderboard: User1 has 6,000,000 spend & 90,000 cashback; User2 has 1,000,000 spend & 200,000 cashback
    upsertNetworkOrder(ensureDbLoaded(), {
      orderSn: `ORD_LB_1_${suffix}`,
      rawSubId: user1.code,
      grossCommission: 100000,
      orderAmount: 6000000,
      status: 'approved',
      platform: 'shopee'
    });
    upsertNetworkOrder(ensureDbLoaded(), {
      orderSn: `ORD_LB_2_${suffix}`,
      rawSubId: user2.code,
      grossCommission: 300000,
      orderAmount: 1000000,
      status: 'approved',
      platform: 'shopee'
    });
    // Pending order must NOT count on leaderboard
    upsertNetworkOrder(ensureDbLoaded(), {
      orderSn: `ORD_LB_PEND_${suffix}`,
      rawSubId: user2.code,
      grossCommission: 9999999,
      orderAmount: 99999999,
      status: 'pending',
      platform: 'shopee'
    });

    const lbRes = await api('/api/leaderboard', {
      headers: { Authorization: `Bearer ${token1}` }
    });
    assert.strictEqual(lbRes.status, 200);
    assert(lbRes.data.topBySpend.length >= 2);
    assert(lbRes.data.topByCashback.length >= 2);
    // User1 tops spend, User2 tops cashback
    const spendIdx1 = lbRes.data.topBySpend.findIndex((r) => r.code === user1.code);
    const spendIdx2 = lbRes.data.topBySpend.findIndex((r) => r.code === user2.code);
    assert(spendIdx1 < spendIdx2, 'User1 must rank higher than User2 on spend');

    const cbIdx1 = lbRes.data.topByCashback.findIndex((r) => r.code === user1.code);
    const cbIdx2 = lbRes.data.topByCashback.findIndex((r) => r.code === user2.code);
    assert(cbIdx2 < cbIdx1, 'User2 must rank higher than User1 on cashback');

    // PII masking check: raw phone and email must NOT appear anywhere in leaderboard JSON
    const rawLbJson = JSON.stringify(lbRes.data);
    assert(!rawLbJson.includes(user1.phone), 'Raw phone must never leak in leaderboard');
    assert(!rawLbJson.includes(user1.email), 'Raw email must never leak in leaderboard');
    assert(lbRes.data.myRankSpend && lbRes.data.myRankSpend.code === user1.code);

    // 7. Server-side gapToAbove / aboveRank / progressToAbove + amountHidden privacy guard
    const spendEntry2 = lbRes.data.topBySpend[spendIdx2];
    if (spendIdx2 > 0) {
      const aboveSpend = lbRes.data.topBySpend[spendIdx2 - 1];
      if (!aboveSpend.amountHidden && !spendEntry2.amountHidden) {
        assert.strictEqual(spendEntry2.aboveRank, spendIdx2);
        assert.strictEqual(spendEntry2.gapToAbove, Math.max(0, Math.round(aboveSpend.totalSpend - spendEntry2.totalSpend)));
        assert(Number.isFinite(spendEntry2.progressToAbove) && spendEntry2.progressToAbove >= 0 && spendEntry2.progressToAbove <= 100);
      }
    }
    // When user directly above hides amount, guest viewer must NOT receive gapToAbove (prevents reverse-engineering)
    const dbForPrivacy = ensureDbLoaded();
    const u1Ref = dbForPrivacy.users.find((u) => u.id === user1.id);
    if (u1Ref) {
      u1Ref.leaderboardHideAmount = true;
      const guestLbRes = await api('/api/leaderboard');
      assert.strictEqual(guestLbRes.status, 200);
      const guestSpendIdx1 = guestLbRes.data.topBySpend.findIndex((r) => r.code === user1.code);
      if (guestSpendIdx1 >= 0 && guestSpendIdx1 + 1 < guestLbRes.data.topBySpend.length) {
        const belowHidden = guestLbRes.data.topBySpend[guestSpendIdx1 + 1];
        assert.strictEqual(belowHidden.gapToAbove, null, 'gapToAbove must be null when user above hides amount');
        assert.strictEqual(belowHidden.progressToAbove, null, 'progressToAbove must be null when user above hides amount');
      }
      u1Ref.leaderboardHideAmount = false;
    }

    console.log('PASS: Stage 2 VIP Tiering (admin table, auto upgrade/downgrade, override) & Public Leaderboard (2 rankings, PII masked, gap privacy)');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
