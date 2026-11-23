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

const SENSITIVE_KEY_RE = /(password|token|secret|authorization|cookie|apikey|api_key|bankaccount|bank_account)/i;

function redactValue(val, depth = 0) {
  if (depth > 4 || val === null || val === undefined) return val;
  if (Array.isArray(val)) return val.map((item) => redactValue(item, depth + 1));
  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      if (SENSITIVE_KEY_RE.test(k) && v !== undefined && v !== null && v !== '') {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactValue(v, depth + 1);
      }
    }
    return out;
  }
  return val;
}

function formatMeta(meta = {}) {
  const ctxReqId = getRequestId();
  const baseMeta = ctxReqId && meta.reqId === undefined ? { reqId: ctxReqId, ...meta } : meta;
  const safeMeta = redactValue(baseMeta);
  const entries = Object.entries(safeMeta).filter(([, v]) => v !== undefined);
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
