require('../server.js');
const { Pool } = require('pg');
const { ensureDbLoaded, saveDb, recalculateAllWallets } = require('../src/services/dbService');

async function cleanTestData() {
  console.log('=== CLEANING TEST DATA FROM DATABASE & MEMORY ===');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL
  });

  const client = await pool.connect();

  const REAL_USER_IDS = [
    'usr_admin',
    'usr_1794458605769_1fd080',
    'usr_1794535334210_7ed84f',
    'usr_1794551680691_116f2d',
    'usr_1794553808929_7bacd7'
  ];

  try {
    await client.query('BEGIN');

    // 1. Delete all test orders
    console.log('1. Clearing test orders in Postgres...');
    const delOrders = await client.query('DELETE FROM orders');
    console.log(`   Deleted ${delOrders.rowCount} orders.`);

    // 2. Delete all test withdrawals
    console.log('2. Clearing test withdrawals in Postgres...');
    const delWd = await client.query('DELETE FROM withdrawals');
    console.log(`   Deleted ${delWd.rowCount} withdrawals.`);

    // 3. Clear test ledger entries
    console.log('3. Finding triggers on ledger in Postgres...');
    const trigRes = await client.query("SELECT trigger_name FROM information_schema.triggers WHERE event_object_table = 'ledger'");
    console.log('   Triggers found:', trigRes.rows);
    for (const t of trigRes.rows) {
      await client.query(`ALTER TABLE ledger DISABLE TRIGGER "${t.trigger_name}"`);
    }
    const delLedger = await client.query('DELETE FROM ledger');
    for (const t of trigRes.rows) {
      await client.query(`ALTER TABLE ledger ENABLE TRIGGER "${t.trigger_name}"`);
    }
    console.log(`   Deleted ${delLedger.rowCount} ledger entries.`);

    // 4. Delete test users, keep only 5 real users
    console.log('4. Clearing test users in Postgres...');
    const delUsers = await client.query(
      'DELETE FROM users WHERE id NOT IN (SELECT unnest($1::text[]))',
      [REAL_USER_IDS]
    );
    console.log(`   Deleted ${delUsers.rowCount} test users.`);

    // 5. Reset balances for remaining real users to 0
    await client.query(
      `UPDATE users 
       SET balance_available = 0, 
           balance_pending = 0, 
           total_earned = 0, 
           total_withdrawn = 0 
       WHERE id IN (SELECT unnest($1::text[]))`,
      [REAL_USER_IDS]
    );
    console.log('5. Reset financial balances to 0 for real users.');

    // 6. Update hoantienshop_state in Postgres with clean snapshot
    const db = ensureDbLoaded();
    db.orders = [];
    db.withdrawals = [];
    db.ledger = [];
    db.users = db.users.filter((u) => REAL_USER_IDS.includes(u.id));
    db.users.forEach((u) => {
      u.balanceAvailable = 0;
      u.balancePending = 0;
      u.totalEarned = 0;
      u.totalWithdrawn = 0;
    });

    console.log('6. Saving clean snapshot into hoantienshop_state...');
    await client.query(
      `UPDATE hoantienshop_state 
       SET payload = $1::jsonb, 
           version = COALESCE(version, 1) + 1,
           updated_at = NOW() 
       WHERE id = 'main'`,
      [JSON.stringify(db)]
    );

    await client.query('COMMIT');
    console.log('7. Postgres transaction committed successfully.');

    // Save into local disk cache as well
    await saveDb(db);
    console.log('8. Local memory & json state synced.');

    console.log('\n=== SUMMARY OF REMAINING CLEAN STATE ===');
    console.log('Users remaining:', db.users.length);
    db.users.forEach((u) => console.log(` - [${u.code}] ${u.name} (${u.phone}) | Role: ${u.role}`));
    console.log('Orders remaining:', db.orders.length);
    console.log('Withdrawals remaining:', db.withdrawals.length);
    console.log('Ledger remaining:', db.ledger.length);
    console.log('\nSUCCESS: All test data purged completely!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR during clean test data:', err);
  } finally {
    client.release();
    await pool.end();
    process.exit(0);
  }
}

cleanTestData();
