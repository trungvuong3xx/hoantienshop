#!/usr/bin/env node
/**
 * scripts/reset-admin-password.js
 *
 * Dedicated utility to safely reset the admin password directly in PostgreSQL & local memory/state.
 * Usage:
 *   node scripts/reset-admin-password.js [newPassword]
 *
 * If no password is provided as an argument, it reads ADMIN_PASSWORD from .env or generates a secure random one.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

// 1. Load .env config
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const k = line.slice(0, eqIdx).trim();
    let v = line.slice(eqIdx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    } else {
      const commentIdx = v.indexOf(' #');
      if (commentIdx !== -1) v = v.slice(0, commentIdx).trim();
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

function hashPassword(pw) {
  if (!pw || typeof pw !== 'string' || pw.length < 6) {
    throw new Error('Mật khẩu không hợp lệ, yêu cầu tối thiểu 6 ký tự.');
  }
  if (pw.length > 128) {
    throw new Error('Mật khẩu không được vượt quá 128 ký tự.');
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function main() {
  const argPassword = process.argv[2]?.trim();
  const envPassword = (process.env.ADMIN_PASSWORD || '').trim();
  const targetPassword = argPassword || envPassword || crypto.randomBytes(8).toString('hex') + 'A@1';

  if (targetPassword.length < 6) {
    console.error('❌ Mật khẩu phải có độ dài tối thiểu 6 ký tự.');
    process.exit(1);
  }

  const targetPhone = (process.env.ADMIN_PHONE || 'trungvuong3x').trim();
  const targetEmail = (process.env.ADMIN_EMAIL || 'trungvuong3x@hoantiensan.online').trim();
  const targetCode = (process.env.ADMIN_CODE || 'TRUNGVUONG3X').trim().toUpperCase();
  const targetName = 'Quản Trị Viên';
  const newHash = hashPassword(targetPassword);

  console.log('====================================================');
  console.log('🔑 ĐẶT LẠI MẬT KHẨU QUẢN TRỊ VIÊN (ADMIN PASSWORD)');
  console.log('====================================================');
  console.log(`- Tài khoản / SĐT:  ${targetPhone}`);
  console.log(`- Mã thành viên:    ${targetCode}`);
  console.log(`- Email quản trị:   ${targetEmail}`);
  console.log(`- Mật khẩu mới:     ${targetPassword}`);
  console.log('----------------------------------------------------');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn('⚠️ Không tìm thấy biến DATABASE_URL. Đang kiểm tra file database.json cục bộ...');
    const localDbPath = path.join(__dirname, '..', 'data', 'database.json');
    if (fs.existsSync(localDbPath)) {
      const data = JSON.parse(fs.readFileSync(localDbPath, 'utf8'));
      if (Array.isArray(data.users)) {
        let admin = data.users.find((u) => u.role === 'admin');
        if (!admin) {
          admin = {
            id: 'usr_admin',
            code: targetCode,
            name: targetName,
            phone: targetPhone,
            email: targetEmail,
            passwordHash: newHash,
            role: 'admin',
            tokenVersion: 1,
            balanceAvailable: 0,
            balancePending: 0,
            totalEarned: 0,
            totalWithdrawn: 0,
            createdAt: new Date().toISOString()
          };
          data.users.unshift(admin);
        } else {
          admin.phone = targetPhone;
          admin.email = targetEmail;
          admin.code = targetCode;
          admin.passwordHash = newHash;
          admin.tokenVersion = Number(admin.tokenVersion || 1) + 1;
        }
        fs.writeFileSync(localDbPath, JSON.stringify(data, null, 2), 'utf8');
        console.log('✅ Đã cập nhật mật khẩu admin trong file data/database.json thành công!');
      }
    } else {
      console.error('❌ Không tìm thấy PostgreSQL DATABASE_URL lẫn file data/database.json.');
      process.exit(1);
    }
    return;
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000
  });

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check if admin user exists in relational users table
      const res = await client.query('SELECT id, role, token_version FROM users WHERE role = $1 OR id = $2', ['admin', 'usr_admin']);
      if (res.rows.length > 0) {
        const existingAdmin = res.rows[0];
        const nextTokenVer = Number(existingAdmin.token_version || 1) + 1;
        await client.query(
          `UPDATE users SET 
            phone = $1, 
            email = $2, 
            code = $3, 
            password_hash = $4, 
            token_version = $5,
            account_locked = FALSE,
            is_deleted = FALSE
           WHERE id = $6`,
          [targetPhone, targetEmail, targetCode, newHash, nextTokenVer, existingAdmin.id]
        );
        console.log(`✅ Đã cập nhật mật khẩu tài khoản Admin (${existingAdmin.id}) trong cơ sở dữ liệu Postgres.`);
      } else {
        await client.query(
          `INSERT INTO users (
            id, code, name, phone, email, password_hash, role, token_version,
            balance_available, balance_pending, total_earned, total_withdrawn,
            bank_name, bank_account, bank_owner, account_locked, is_deleted, created_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, 'admin', 1,
            0, 0, 0, 0,
            'MBBank', '', '', FALSE, FALSE, NOW()
          )`,
          ['usr_admin', targetCode, targetName, targetPhone, targetEmail, newHash]
        );
        console.log('✅ Đã tạo mới và đồng bộ tài khoản Admin (usr_admin) vào cơ sở dữ liệu Postgres.');
      }

      // Bump hoantienshop_state version to notify all worker instances
      await client.query(
        `UPDATE hoantienshop_state SET version = version + 1, updated_at = NOW() WHERE id = 'main'`
      );

      await client.query('COMMIT');
      console.log('----------------------------------------------------');
      console.log('🎉 THÀNH CÔNG! Bạn có thể đăng nhập vào trang quản trị ngay với:');
      console.log(`👉 Link đăng nhập:   /admin (hoặc bấm Đăng nhập trên web)`);
      console.log(`👉 Tên đăng nhập:    ${targetPhone}`);
      console.log(`👉 Mật khẩu:         ${targetPassword}`);
      console.log('====================================================');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('❌ Lỗi khi cập nhật cơ sở dữ liệu:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('❌ Lỗi không mong muốn:', err);
  process.exit(1);
});
