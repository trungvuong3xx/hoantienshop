const crypto = require('crypto');

function withdrawalFromRow(row) {
  return {
    id: row.id, userId: row.user_id, userCode: row.user_code,
    userName: row.user_name, userPhone: row.user_phone, amount: Number(row.amount),
    method: row.method, bankName: row.bank_name, bankAccount: row.bank_account,
    bankOwner: row.bank_owner, status: row.status, idempotencyKey: row.idempotency_key,
    createdAt: new Date(row.created_at).toISOString(),
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
    processedAt: row.processed_at ? new Date(row.processed_at).toISOString() : null
  };
}

function conflict(message, code = 'WITHDRAWAL_CONFLICT') {
  const error = new Error(message);
  error.status = 409;
  error.code = code;
  return error;
}

// Lock order matches snapshot persistence and withdrawal creation. The transaction
// owns the state transition, reserved debit, refund, wallet projection and audit.
async function settleWithdrawal(pool, id, status, admin = {}, { archive = false } = {}) {
  if (!id || !['paid', 'rejected'].includes(status) || (archive && status !== 'rejected')) {
    const error = new Error('Lệnh rút tiền hoặc trạng thái không hợp lệ.');
    error.status = 400;
    throw error;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT version FROM hoantienshop_state WHERE id = 'main' FOR UPDATE");
    const selected = await client.query('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id]);
    const row = selected.rows[0];
    if (!row) {
      const error = new Error('Không tìm thấy yêu cầu rút tiền.');
      error.status = 404;
      throw error;
    }
    if (row.status === status && (!archive || row.archived_at)) {
      await client.query('COMMIT');
      return withdrawalFromRow(row);
    }
    if (row.status !== 'pending' && !(archive && row.status === 'rejected')) throw conflict('Lệnh rút tiền đã xử lý, không thể đổi trạng thái.');
    const amount = Number(row.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw conflict('Số tiền rút không hợp lệ.', 'WITHDRAWAL_INTEGRITY');
    const user = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [row.user_id]);
    if (!user.rows.length) throw conflict('Không tìm thấy chủ lệnh rút.', 'WITHDRAWAL_INTEGRITY');
    const debit = await client.query('SELECT user_id, amount FROM ledger WHERE ref_id = $1', [`withdraw_debit_${id}`]);
    if (debit.rows[0]?.user_id !== row.user_id || Number(debit.rows[0]?.amount) !== -amount) {
      throw conflict('Bút toán giữ tiền không khớp lệnh rút. Cần đối soát trước khi xử lý.', 'WITHDRAWAL_INTEGRITY');
    }
    const refund = await client.query('SELECT id, user_id, amount FROM ledger WHERE ref_id = $1', [`withdraw_refund_${id}`]);
    if (row.status === 'rejected' && (refund.rows[0]?.user_id !== row.user_id || Number(refund.rows[0]?.amount) !== amount)) throw conflict('Bút toán hoàn tiền không khớp.', 'WITHDRAWAL_INTEGRITY');
    if (row.status === 'pending' && refund.rows.length) throw conflict('Lệnh đang chờ nhưng đã có bút toán hoàn tiền.', 'WITHDRAWAL_INTEGRITY');
    if (status === 'rejected' && row.status === 'pending') {
      await client.query(
        `INSERT INTO ledger (id, user_id, type, amount, ref_id, note)
         VALUES ($1, $2, 'withdrawal_refund', $3, $4, $5)`,
        [crypto.randomUUID(), row.user_id, amount, `withdraw_refund_${id}`, `Hoàn lại lệnh rút tiền bị từ chối #${id}`]
      );
    }
    const updated = await client.query(`UPDATE withdrawals SET status = $2, processed_at = COALESCE(processed_at, NOW()),
       archived_at = CASE WHEN $3 THEN COALESCE(archived_at, NOW()) ELSE archived_at END
       WHERE id = $1 RETURNING *`, [id, status, archive]);
    await client.query(
      `UPDATE users SET
         balance_available = (SELECT COALESCE(SUM(amount), 0) FROM ledger WHERE user_id = $1),
         total_withdrawn = (SELECT COALESCE(SUM(amount), 0) FROM withdrawals WHERE user_id = $1 AND status = 'paid')
       WHERE id = $1`, [row.user_id]
    );
    await client.query(
      'INSERT INTO audit_logs (id, admin_id, admin_name, action, target_id, details) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
      [crypto.randomUUID(), admin.id || 'admin', admin.name || admin.code || 'Admin', archive ? 'archive_withdrawal' : 'update_withdrawal', id,
        JSON.stringify({ fromStatus: row.status, status, archived: archive, amount, userCode: row.user_code })]
    );
    await client.query("UPDATE hoantienshop_state SET version = version + 1, updated_at = NOW() WHERE id = 'main'");
    await client.query('COMMIT');
    return withdrawalFromRow(updated.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { settleWithdrawal, withdrawalFromRow };
