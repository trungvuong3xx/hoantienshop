const crypto = require('crypto');
const logger = require('../utils/logger');
const { ensureDbLoaded, getPgPool } = require('./dbService');

const RETENTION_DAYS = 90;
let lastCleanupAt = 0;

function makeId(prefix = 'ntf') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function getMemoryStore() {
  const db = ensureDbLoaded();
  if (!Array.isArray(db.notifications)) db.notifications = [];
  if (!Array.isArray(db.notificationReads)) db.notificationReads = [];
  return db;
}

function mapPgNotificationRow(row) {
  return {
    id: row.id,
    userId: row.user_id || null,
    type: row.type,
    title: row.title,
    message: row.message,
    dedupeKey: row.dedupe_key || null,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    isRead: Boolean(row.effective_is_read ?? row.is_read),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString()
  };
}

/**
 * Periodically prune notifications older than RETENTION_DAYS (at most once per hour).
 */
async function cleanupOldNotificationsIfNeeded() {
  const now = Date.now();
  if (now - lastCleanupAt < 60 * 60 * 1000) return;
  lastCleanupAt = now;

  const pool = getPgPool();
  if (pool) {
    try {
      await pool.query(
        `DELETE FROM notifications WHERE created_at < NOW() - ($1 || ' days')::INTERVAL`,
        [String(RETENTION_DAYS)]
      );
      await pool.query(
        `DELETE FROM notification_reads WHERE notification_id NOT IN (SELECT id FROM notifications)`
      );
    } catch (err) {
      logger.warning('cleanupOldNotificationsIfNeeded', 'Cleanup Postgres notifications skipped', {
        error: err.message
      });
    }
    return;
  }

  const db = getMemoryStore();
  const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  db.notifications = db.notifications.filter((n) => new Date(n.createdAt).getTime() >= cutoff);
  const validIds = new Set(db.notifications.map((n) => n.id));
  db.notificationReads = db.notificationReads.filter((r) => validIds.has(r.notificationId));
}

/**
 * Create a personal or broadcast notification with optional dedupeKey for idempotency.
 */
async function createNotification({
  userId = null,
  type = 'system',
  title,
  message,
  dedupeKey = null,
  metadata = {}
} = {}) {
  if (!title || !message) return null;
  const id = makeId('ntf');
  const cleanUserId = userId ? String(userId).trim() : null;
  const cleanDedupeKey = dedupeKey ? String(dedupeKey).trim() : null;
  const safeMeta = metadata && typeof metadata === 'object' ? metadata : {};
  const createdAt = new Date().toISOString();

  const pool = getPgPool();
  if (pool) {
    try {
      const res = await pool.query(
        `INSERT INTO notifications (id, user_id, type, title, message, dedupe_key, metadata, is_read, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, FALSE, $8)
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING *`,
        [id, cleanUserId, String(type), String(title), String(message), cleanDedupeKey, JSON.stringify(safeMeta), createdAt]
      );
      void cleanupOldNotificationsIfNeeded();
      return res.rows.length > 0 ? mapPgNotificationRow(res.rows[0]) : null;
    } catch (err) {
      logger.warning('createNotification', 'Postgres insert failed, falling back to memory', { error: err.message });
    }
  }

  const db = getMemoryStore();
  if (cleanDedupeKey && db.notifications.some((n) => n.dedupeKey === cleanDedupeKey)) {
    return null;
  }
  const item = {
    id,
    userId: cleanUserId,
    type: String(type),
    title: String(title),
    message: String(message),
    dedupeKey: cleanDedupeKey,
    metadata: safeMeta,
    isRead: false,
    createdAt
  };
  db.notifications.unshift(item);
  if (db.notifications.length > 1000) {
    db.notifications.length = 1000;
  }
  void cleanupOldNotificationsIfNeeded();
  return item;
}

/**
 * Count unread notifications (personal + unread broadcasts) for a user.
 */
async function getUnreadNotificationCount(userId) {
  if (!userId) return 0;
  const cleanUserId = String(userId);
  const pool = getPgPool();
  if (pool) {
    try {
      const res = await pool.query(
        `SELECT COUNT(*)::int AS cnt
         FROM notifications n
         LEFT JOIN notification_reads nr
           ON nr.notification_id = n.id AND nr.user_id = $1
         WHERE (n.user_id = $1 AND n.is_read = FALSE)
            OR (n.user_id IS NULL AND nr.notification_id IS NULL)`,
        [cleanUserId]
      );
      return Number(res.rows[0]?.cnt || 0);
    } catch (err) {
      logger.warning('getUnreadNotificationCount', 'Postgres count failed, falling back to memory', {
        error: err.message
      });
    }
  }

  const db = getMemoryStore();
  const readBroadcastIds = new Set(
    db.notificationReads.filter((r) => r.userId === cleanUserId).map((r) => r.notificationId)
  );
  return db.notifications.filter(
    (n) =>
      (n.userId === cleanUserId && !n.isRead) ||
      (n.userId === null && !readBroadcastIds.has(n.id))
  ).length;
}

/**
 * Fetch paginated notifications for a user (personal + broadcasts with per-user read status).
 */
async function getUserNotifications(userId, { page = 1, limit = 20 } = {}) {
  const cleanUserId = String(userId || '');
  if (!cleanUserId) {
    return { items: [], unreadCount: 0, pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } };
  }

  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  const safePage = Math.max(1, Number(page) || 1);

  const pool = getPgPool();
  if (pool) {
    try {
      const countRes = await pool.query(
        `SELECT COUNT(*)::int AS total FROM notifications WHERE user_id = $1 OR user_id IS NULL`,
        [cleanUserId]
      );
      const total = Number(countRes.rows[0]?.total || 0);
      const totalPages = Math.max(1, Math.ceil(total / safeLimit));
      const clampedPage = Math.min(safePage, totalPages);
      const offset = (clampedPage - 1) * safeLimit;

      const listRes = await pool.query(
        `SELECT n.*,
                CASE
                  WHEN n.user_id IS NOT NULL THEN n.is_read
                  ELSE (nr.notification_id IS NOT NULL)
                END AS effective_is_read
         FROM notifications n
         LEFT JOIN notification_reads nr
           ON nr.notification_id = n.id AND nr.user_id = $1
         WHERE n.user_id = $1 OR n.user_id IS NULL
         ORDER BY n.created_at DESC
         LIMIT $2 OFFSET $3`,
        [cleanUserId, safeLimit, offset]
      );
      const unreadCount = await getUnreadNotificationCount(cleanUserId);
      return {
        items: listRes.rows.map(mapPgNotificationRow),
        unreadCount,
        pagination: { page: clampedPage, limit: safeLimit, total, totalPages }
      };
    } catch (err) {
      logger.warning('getUserNotifications', 'Postgres query failed, falling back to memory', {
        error: err.message
      });
    }
  }

  const db = getMemoryStore();
  const readBroadcastIds = new Set(
    db.notificationReads.filter((r) => r.userId === cleanUserId).map((r) => r.notificationId)
  );
  const allForUser = db.notifications
    .filter((n) => n.userId === cleanUserId || n.userId === null)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((n) => ({
      ...n,
      isRead: n.userId !== null ? Boolean(n.isRead) : readBroadcastIds.has(n.id)
    }));

  const total = allForUser.length;
  const totalPages = Math.max(1, Math.ceil(total / safeLimit));
  const clampedPage = Math.min(safePage, totalPages);
  const offset = (clampedPage - 1) * safeLimit;
  const unreadCount = allForUser.filter((n) => !n.isRead).length;

  return {
    items: allForUser.slice(offset, offset + safeLimit),
    unreadCount,
    pagination: { page: clampedPage, limit: safeLimit, total, totalPages }
  };
}

/**
 * Mark a single notification or all notifications as read for a user.
 */
async function markNotificationsRead(userId, { id = null, all = false } = {}) {
  const cleanUserId = String(userId || '');
  if (!cleanUserId) return { unreadCount: 0 };

  const pool = getPgPool();
  if (pool) {
    try {
      if (all) {
        await pool.query(
          `UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE`,
          [cleanUserId]
        );
        await pool.query(
          `INSERT INTO notification_reads (notification_id, user_id, read_at)
           SELECT n.id, $1, NOW()
           FROM notifications n
           LEFT JOIN notification_reads nr
             ON nr.notification_id = n.id AND nr.user_id = $1
           WHERE n.user_id IS NULL AND nr.notification_id IS NULL
           ON CONFLICT (notification_id, user_id) DO NOTHING`,
          [cleanUserId]
        );
      } else if (id) {
        const cleanId = String(id).trim();
        const check = await pool.query(
          `SELECT id, user_id FROM notifications WHERE id = $1 AND (user_id = $2 OR user_id IS NULL) LIMIT 1`,
          [cleanId, cleanUserId]
        );
        if (check.rows.length > 0) {
          if (check.rows[0].user_id) {
            await pool.query(
              `UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2`,
              [cleanId, cleanUserId]
            );
          } else {
            await pool.query(
              `INSERT INTO notification_reads (notification_id, user_id, read_at)
               VALUES ($1, $2, NOW())
               ON CONFLICT (notification_id, user_id) DO NOTHING`,
              [cleanId, cleanUserId]
            );
          }
        }
      }
      const unreadCount = await getUnreadNotificationCount(cleanUserId);
      return { unreadCount };
    } catch (err) {
      logger.warning('markNotificationsRead', 'Postgres update failed, falling back to memory', {
        error: err.message
      });
    }
  }

  const db = getMemoryStore();
  if (all) {
    for (const n of db.notifications) {
      if (n.userId === cleanUserId) {
        n.isRead = true;
      } else if (n.userId === null) {
        if (!db.notificationReads.some((r) => r.notificationId === n.id && r.userId === cleanUserId)) {
          db.notificationReads.push({ notificationId: n.id, userId: cleanUserId, readAt: new Date().toISOString() });
        }
      }
    }
  } else if (id) {
    const target = db.notifications.find(
      (n) => n.id === id && (n.userId === cleanUserId || n.userId === null)
    );
    if (target) {
      if (target.userId === cleanUserId) {
        target.isRead = true;
      } else if (!db.notificationReads.some((r) => r.notificationId === target.id && r.userId === cleanUserId)) {
        db.notificationReads.push({ notificationId: target.id, userId: cleanUserId, readAt: new Date().toISOString() });
      }
    }
  }

  const unreadCount = await getUnreadNotificationCount(cleanUserId);
  return { unreadCount };
}

module.exports = {
  createNotification,
  getUnreadNotificationCount,
  getUserNotifications,
  markNotificationsRead,
  cleanupOldNotificationsIfNeeded
};
