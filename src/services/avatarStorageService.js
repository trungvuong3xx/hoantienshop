const crypto = require('crypto');
const logger = require('../utils/logger');
const { getPgPool } = require('./dbService');

const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB server hard cap (client compresses up to 5 MB source down to ~25-80 KB)
const AVATAR_ID_REGEX = /^avt_[a-zA-Z0-9_-]{8,80}$/;

const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};

// In-memory store used when PostgreSQL and external Object Storage are not configured (e.g., unit tests / local memory mode)
const memoryAvatars = new Map();

/**
 * Inspect actual binary magic bytes (never trusts filename extension or Content-Type header alone).
 * Supports ONLY JPEG, PNG, and WEBP. Rejects SVG, HTML, GIF, executables, scripts, etc.
 */
function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  // WEBP: "RIFF" (0..3) + "WEBP" (8..11)
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

function validateAvatarBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, status: 400, error: 'Dữ liệu ảnh trống. Vui lòng chọn ảnh hợp lệ.' };
  }
  if (buffer.length > MAX_AVATAR_BYTES) {
    return { ok: false, status: 413, error: 'Ảnh sau khi xử lý vượt quá dung lượng cho phép (tối đa 2 MB).' };
  }
  const mimeType = detectImageMime(buffer);
  if (!mimeType) {
    return {
      ok: false,
      status: 400,
      error: 'Định dạng ảnh không hợp lệ. Chỉ chấp nhận file ảnh thật định dạng JPG, PNG hoặc WEBP.'
    };
  }
  return { ok: true, mimeType };
}

function getStorageDriverName() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return 'vercel_blob';
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return 'supabase_storage';
  if (getPgPool()) return 'postgres_storage';
  return 'memory_storage';
}

function buildAvatarId(userId) {
  const safeUid = String(userId || 'usr').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) || 'usr';
  const rand = crypto.randomBytes(6).toString('hex');
  return `avt_${safeUid}_${Date.now()}_${rand}`;
}

async function uploadToVercelBlob(avatarId, buffer, mimeType) {
  const ext = MIME_TO_EXT[mimeType] || 'webp';
  const pathname = `avatars/${avatarId}.${ext}`;
  const res = await fetch(`https://blob.vercel-storage.com/${pathname}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,
      'Content-Type': mimeType,
      'x-content-type': mimeType,
      'x-add-random-suffix': '0'
    },
    body: buffer
  });
  if (!res.ok) {
    const errTxt = await res.text().catch(() => '');
    throw new Error(`Vercel Blob upload failed (${res.status}): ${errTxt.slice(0, 120)}`);
  }
  const data = await res.json();
  if (!data?.url) throw new Error('Vercel Blob response missing URL');
  return data.url;
}

async function deleteFromVercelBlob(oldUrl) {
  if (!process.env.BLOB_READ_WRITE_TOKEN || !oldUrl || !oldUrl.includes('blob.vercel-storage.com')) return;
  try {
    await fetch('https://blob.vercel-storage.com/delete', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ urls: [oldUrl] })
    });
  } catch (err) {
    logger.warning('deleteFromVercelBlob', 'Failed to delete old Vercel Blob avatar', { error: err.message });
  }
}

async function uploadToSupabaseStorage(avatarId, buffer, mimeType) {
  const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const bucket = String(process.env.SUPABASE_AVATAR_BUCKET || 'avatars').replace(/[^a-zA-Z0-9_-]/g, '') || 'avatars';
  const ext = MIME_TO_EXT[mimeType] || 'webp';
  const objectPath = `${avatarId}.${ext}`;
  const res = await fetch(`${baseUrl}/storage/v1/object/${bucket}/${objectPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': mimeType,
      'x-upsert': 'true'
    },
    body: buffer
  });
  if (!res.ok) {
    const errTxt = await res.text().catch(() => '');
    throw new Error(`Supabase Storage upload failed (${res.status}): ${errTxt.slice(0, 120)}`);
  }
  return `${baseUrl}/storage/v1/object/public/${bucket}/${objectPath}`;
}

async function deleteFromSupabaseStorage(oldUrl) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !oldUrl) return;
  const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const prefix = `${baseUrl}/storage/v1/object/public/`;
  if (!oldUrl.startsWith(prefix)) return;
  const remainder = oldUrl.slice(prefix.length);
  const slashIdx = remainder.indexOf('/');
  if (slashIdx <= 0) return;
  const bucket = remainder.slice(0, slashIdx);
  const objectPath = remainder.slice(slashIdx + 1);
  try {
    await fetch(`${baseUrl}/storage/v1/object/${bucket}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prefixes: [objectPath] })
    });
  } catch (err) {
    logger.warning('deleteFromSupabaseStorage', 'Failed to delete old Supabase avatar', { error: err.message });
  }
}

async function saveAvatar(userId, buffer, mimeType) {
  logger.logEnter('saveAvatar', { userId, mimeType, bytes: buffer.length });
  const avatarId = buildAvatarId(userId);
  const driver = getStorageDriverName();
  let avatarUrl = '';

  if (driver === 'vercel_blob') {
    avatarUrl = await uploadToVercelBlob(avatarId, buffer, mimeType);
  } else if (driver === 'supabase_storage') {
    avatarUrl = await uploadToSupabaseStorage(avatarId, buffer, mimeType);
  } else if (driver === 'postgres_storage') {
    const pool = getPgPool();
    await pool.query(
      `INSERT INTO user_avatars (id, user_id, mime_type, data, size_bytes)
       VALUES ($1, $2, $3, $4, $5)`,
      [avatarId, userId, mimeType, buffer, buffer.length]
    );
    avatarUrl = `/api/avatars/${avatarId}`;
  } else {
    memoryAvatars.set(avatarId, {
      id: avatarId,
      userId,
      mimeType,
      data: Buffer.from(buffer),
      sizeBytes: buffer.length
    });
    avatarUrl = `/api/avatars/${avatarId}`;
  }

  logger.logLeave('saveAvatar', { userId, driver, avatarId });
  return { avatarId, avatarUrl, driver };
}

async function getAvatar(avatarId) {
  if (!AVATAR_ID_REGEX.test(String(avatarId || ''))) return null;
  const pool = getPgPool();
  if (pool) {
    const res = await pool.query('SELECT mime_type, data FROM user_avatars WHERE id = $1 LIMIT 1', [avatarId]);
    if (res.rows.length > 0) {
      return {
        mimeType: res.rows[0].mime_type,
        data: Buffer.isBuffer(res.rows[0].data) ? res.rows[0].data : Buffer.from(res.rows[0].data)
      };
    }
    return null;
  }
  const item = memoryAvatars.get(avatarId);
  return item ? { mimeType: item.mimeType, data: item.data } : null;
}

async function deleteAvatar(oldUrl, userId) {
  if (!oldUrl || typeof oldUrl !== 'string') return;
  logger.logEnter('deleteAvatar', { userId });
  try {
    if (oldUrl.startsWith('/api/avatars/')) {
      const oldId = oldUrl.slice('/api/avatars/'.length).split('?')[0];
      if (!AVATAR_ID_REGEX.test(oldId)) return;
      const pool = getPgPool();
      if (pool) {
        await pool.query('DELETE FROM user_avatars WHERE id = $1 AND user_id = $2', [oldId, userId]);
      } else {
        const existing = memoryAvatars.get(oldId);
        if (existing && existing.userId === userId) {
          memoryAvatars.delete(oldId);
        }
      }
    } else if (oldUrl.includes('blob.vercel-storage.com')) {
      await deleteFromVercelBlob(oldUrl);
    } else if (process.env.SUPABASE_URL && oldUrl.startsWith(String(process.env.SUPABASE_URL).replace(/\/+$/, ''))) {
      await deleteFromSupabaseStorage(oldUrl);
    }
  } catch (err) {
    logger.warning('deleteAvatar', 'Non-blocking cleanup of previous avatar failed', { userId, error: err.message });
  }
  logger.logLeave('deleteAvatar', { userId });
}

module.exports = {
  MAX_AVATAR_BYTES,
  AVATAR_ID_REGEX,
  detectImageMime,
  validateAvatarBuffer,
  getStorageDriverName,
  saveAvatar,
  getAvatar,
  deleteAvatar
};
