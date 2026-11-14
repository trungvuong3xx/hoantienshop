const { AsyncLocalStorage } = require('async_hooks');

/**
 * Structured logger following [] formatting and | separator convention
 * with AsyncLocalStorage request tracing support.
 */

const requestContextStorage = new AsyncLocalStorage();

/**
 * Run a callback inside a request tracing context carrying requestId.
 */
function runWithRequestContext(context, fn) {
  return requestContextStorage.run(context || {}, fn);
}

/**
 * Retrieve the active requestId from AsyncLocalStorage context, if any.
 */
function getRequestId() {
  const store = requestContextStorage.getStore();
  return store?.requestId || null;
}

function formatMeta(meta = {}) {
  const ctxReqId = getRequestId();
  const baseMeta = ctxReqId && meta.reqId === undefined ? { reqId: ctxReqId, ...meta } : meta;
  const entries = Object.entries(baseMeta).filter(([, v]) => v !== undefined);
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
  error,
  runWithRequestContext,
  getRequestId
};
