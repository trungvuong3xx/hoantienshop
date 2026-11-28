/**
 * Lightweight Per-Provider Circuit Breaker for Cross-Platform Compare Upstream APIs.
 * Prevents cascading latency & IP/key throttling when an upstream returns repeated 429/5xx/timeouts.
 */

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_OPEN_DURATION_MS = 45 * 1000;

const circuits = new Map();

function getCircuit(providerName) {
  let c = circuits.get(providerName);
  if (!c) {
    c = {
      state: 'closed', // 'closed' | 'open' | 'half_open'
      failures: [],
      openedAt: 0
    };
    circuits.set(providerName, c);
  }
  return c;
}

function canExecute(providerName, options = {}) {
  const openDurationMs = options.openDurationMs || DEFAULT_OPEN_DURATION_MS;
  const c = getCircuit(providerName);
  if (c.state === 'closed') return true;
  if (c.state === 'open') {
    if (Date.now() - c.openedAt >= openDurationMs) {
      c.state = 'half_open';
      return true;
    }
    return false;
  }
  // half_open allows probe
  return true;
}

function recordSuccess(providerName) {
  const c = getCircuit(providerName);
  c.state = 'closed';
  c.failures = [];
  c.openedAt = 0;
}

function recordFailure(providerName, options = {}) {
  const threshold = options.failureThreshold || DEFAULT_FAILURE_THRESHOLD;
  const windowMs = options.windowMs || DEFAULT_WINDOW_MS;
  const now = Date.now();
  const c = getCircuit(providerName);

  c.failures = c.failures.filter((ts) => now - ts <= windowMs);
  c.failures.push(now);

  if (c.state === 'half_open' || c.failures.length >= threshold) {
    c.state = 'open';
    c.openedAt = now;
  }
}

function getCircuitState(providerName) {
  return getCircuit(providerName).state;
}

function resetCircuitBreakers() {
  circuits.clear();
}

module.exports = {
  canExecute,
  recordSuccess,
  recordFailure,
  getCircuitState,
  resetCircuitBreakers
};
