// Shared helpers for the WORQEND voice negotiation API (Vercel Node.js functions).
// Files starting with "_" in /api are not exposed as routes.
const crypto = require('crypto');

const env = name => (process.env[name] || '').trim();
const CFG = () => ({
  openaiKey: env('OPENAI_API_KEY'),
  gasUrl: env('GAS_URL'),
  secret: env('WORQEND_SERVER_SECRET'),
  model: env('OPENAI_REALTIME_MODEL') || 'gpt-realtime-2.1-mini',
  voice: env('OPENAI_REALTIME_VOICE') || 'marin',
  transcribe: env('OPENAI_TRANSCRIBE_MODEL') || 'gpt-4o-mini-transcribe',
  openaiBase: env('OPENAI_BASE_URL') || 'https://api.openai.com/v1'   // only overridden in tests
});

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
function fail(res, status, code, message) { send(res, status, { ok: false, code, error: message }); }

/** Accept JSON bodies (fetch) and text bodies (navigator.sendBeacon). */
async function body(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let raw = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!raw) raw = await new Promise((ok, ko) => { let s = ''; req.on('data', c => { s += c; if (s.length > 600000) ko(new Error('Body too large')); }); req.on('end', () => ok(s)); req.on('error', ko); });
  if (raw.length > 600000) throw new Error('Body too large');
  try { return JSON.parse(raw || '{}'); } catch (_) { throw new Error('Invalid JSON'); }
}

function configured(res) {
  const c = CFG();
  const missing = ['OPENAI_API_KEY', 'GAS_URL', 'WORQEND_SERVER_SECRET'].filter(k => !env(k));
  if (missing.length || c.secret.length < 24) { fail(res, 503, 'NOT_CONFIGURED', 'Voice negotiation is not set up on the server yet.'); console.error('Missing env:', missing.join(', ') || 'WORQEND_SERVER_SECRET too short'); return null; }
  return c;
}
function onlyPost(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); fail(res, 405, 'METHOD', 'POST only'); return false; }
  const origin = req.headers.origin, host = req.headers['x-forwarded-host'] || req.headers.host;
  const allowed = env('ALLOWED_ORIGIN');
  if (origin && host && new URL(origin).host !== host && (!allowed || origin !== allowed)) { fail(res, 403, 'ORIGIN', 'Cross-origin requests are not allowed.'); return false; }
  return true;
}

/** Server-to-server call to Apps Script (secret travels in the body; Apps Script cannot read headers). */
async function gas(action, payload, timeoutMs = 25000) {
  const c = CFG();
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(c.gasUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, secret: c.secret, ...payload }), redirect: 'follow', signal: ctl.signal });
    const txt = await r.text();
    let j; try { j = JSON.parse(txt); } catch (_) { throw new Error('GAS_BAD_RESPONSE'); }
    if (!j.ok) { const e = new Error(j.error || 'GAS error'); e.gas = true; throw e; }
    return j.data;
  } finally { clearTimeout(t); }
}

/** Map Apps Script error prefixes to HTTP responses the browser can show. */
function gasError(res, e) {
  const m = String(e && e.message || e);
  const table = [['AUTH:', 401, 'AUTH'], ['NOT_ALLOWED:', 403, 'NOT_ALLOWED'], ['DISABLED:', 403, 'DISABLED'], ['BUSY:', 429, 'BUSY'], ['BUDGET:', 402, 'BUDGET'], ['VOICE_NOT_CONFIGURED', 503, 'NOT_CONFIGURED'], ['FORBIDDEN', 503, 'NOT_CONFIGURED']];
  for (const [p, status, code] of table) if (m.startsWith(p)) return fail(res, status, code, p.endsWith(':') ? m.slice(p.length).trim() : 'Voice negotiation is not set up on the server yet.');
  console.error('GAS call failed:', m);
  return fail(res, 502, 'UPSTREAM', 'The WORQEND server did not respond. Please try again.');
}

/* Session tokens: HMAC(sessionId) so only the browser that started a session can use/end it. */
const sign = id => crypto.createHmac('sha256', CFG().secret).update('voice:' + id).digest('base64url');
function verify(id, token) {
  if (!id || !token || typeof id !== 'string' || typeof token !== 'string') return false;
  const a = Buffer.from(sign(id)), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function secretOk(s) { const a = Buffer.from(String(s || '')), b = Buffer.from(CFG().secret); return a.length === b.length && crypto.timingSafeEqual(a, b); }

/** End an OpenAI Realtime call (POST /v1/realtime/calls/{call_id}/hangup). Best-effort, no retries. */
async function hangup(callId) {
  if (!callId || !/^[\w-]{4,200}$/.test(callId)) return false;
  const c = CFG();
  try {
    const r = await fetch(`${c.openaiBase}/realtime/calls/${encodeURIComponent(callId)}/hangup`, { method: 'POST', headers: { Authorization: `Bearer ${c.openaiKey}` } });
    return r.ok || r.status === 404;
  } catch (e) { console.error('hangup failed', callId, e.message); return false; }
}

module.exports = { CFG, send, fail, body, configured, onlyPost, gas, gasError, sign, verify, secretOk, hangup };
