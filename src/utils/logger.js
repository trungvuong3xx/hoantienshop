/**
 * Structured logger following [] formatting and | separator convention.
 */

function formatMeta(meta = {}) {
  const entries = Object.entries(meta).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '';
  return entries
    .map(([k, v]) => `[${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}]`)
    .join(' | ');
}

function timestamp() {
  return new Date().toISOString();
}

function logEnter(fnName, params = {}) {
  const metaStr = formatMeta(params);
  console.log(`[${timestamp()}] | [ENTER] | [${fnName}]${metaStr ? ' | ' + metaStr : ''}`);
}

function logLeave(fnName, result = {}) {
  const metaStr = formatMeta(result);
  console.log(`[${timestamp()}] | [LEAVE] | [${fnName}]${metaStr ? ' | ' + metaStr : ''}`);
}

function log(fnName, message, meta = {}) {
  const metaStr = formatMeta(meta);
  console.log(`[${timestamp()}] | [INFO] | [${fnName}] | [${message}]${metaStr ? ' | ' + metaStr : ''}`);
}

function warning(fnName, message, meta = {}) {
  const metaStr = formatMeta(meta);
  console.warn(`[${timestamp()}] | [WARN] | [${fnName}] | [${message}]${metaStr ? ' | ' + metaStr : ''}`);
}

function error(fnName, message, meta = {}) {
  const metaStr = formatMeta(meta);
  console.error(`[${timestamp()}] | [ERROR] | [${fnName}] | [${message}]${metaStr ? ' | ' + metaStr : ''}`);
}

module.exports = {
  logEnter,
  logLeave,
  log,
  warning,
  error
};
