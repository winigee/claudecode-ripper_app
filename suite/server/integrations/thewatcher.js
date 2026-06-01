// Praixis → TheWatcher connector.
//
// TheWatcher is an independent timekeeper service (separate repo). Praixis is a
// client of its API — see ../../INTEGRATION.md for the contract. Every call is
// time-boxed and failure-tolerant: if TheWatcher is unreachable, callers get a
// clear { connected:false } / thrown error and Praixis falls back to local time
// entries. Nothing here assumes TheWatcher is running.

const DEFAULT_TIMEOUT = 2500;

async function call(baseUrl, method, path, body, timeoutMs = DEFAULT_TIMEOUT) {
  if (!baseUrl) { const e = new Error('TheWatcher URL not configured'); e.code = 'NOT_CONFIGURED'; throw e; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(baseUrl.replace(/\/$/, '') + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await resp.text();
    const json = text ? safeJson(text) : null;
    if (!resp.ok) { const e = new Error(`TheWatcher ${resp.status}: ${json?.error || text.slice(0, 120)}`); e.status = resp.status; throw e; }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') { const t = new Error('TheWatcher timed out'); t.code = 'TIMEOUT'; throw t; }
    if (e.code === 'ECONNREFUSED' || /fetch failed/i.test(e.message)) { const t = new Error('TheWatcher unreachable'); t.code = 'UNREACHABLE'; throw t; }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
function safeJson(t) { try { return JSON.parse(t); } catch (_) { return null; } }

// Health / identity. Never throws — returns a status object.
async function status(baseUrl) {
  if (!baseUrl) return { connected: false, configured: false, url: null };
  try {
    const h = await call(baseUrl, 'GET', '/health', null, 1500);
    return { connected: true, configured: true, url: baseUrl, service: h?.service, version: h?.version };
  } catch (e) {
    return { connected: false, configured: true, url: baseUrl, error: e.code || e.message };
  }
}

const listTimers = (baseUrl) => call(baseUrl, 'GET', '/api/timers');
const startTimer = (baseUrl, payload) => call(baseUrl, 'POST', '/api/timers', payload);
const stopTimer = (baseUrl, id) => call(baseUrl, 'POST', `/api/timers/${encodeURIComponent(id)}/stop`);
const createEntry = (baseUrl, entry) => call(baseUrl, 'POST', '/api/entries', entry);
function listEntries(baseUrl, { matterId, from, to } = {}) {
  const q = new URLSearchParams();
  if (matterId) q.set('matterId', matterId);
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  const qs = q.toString();
  return call(baseUrl, 'GET', '/api/entries' + (qs ? `?${qs}` : ''));
}

module.exports = { status, listTimers, startTimer, stopTimer, listEntries, createEntry };
