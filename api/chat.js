// Vercel Serverless Function — proxies requests to the Claude API so the key never reaches the browser.
// Env vars (Vercel → Project → Settings → Environment Variables):
//   ANTHROPIC_API_KEY  (required)
//   TOKEN_SECRET       (recommended — same value as the Apps Script TOKEN_SECRET; only signed-in members can call the AI)
//   ACCESS_CODE        (legacy fallback, used only when TOKEN_SECRET is not set)
//   CHAT_MODEL         (optional, default claude-haiku-5-5 — fast, for live meeting turns)
//   REPORT_MODEL       (optional, default claude-sonnet-5-5 — deeper, for the feedback report and file → scenario conversion)

import crypto from 'crypto';

function verifyToken(token, secret) {
  if (!token) return null;
  const [p, sig] = String(token).split('.');
  if (!p || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(p).digest('base64url');
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    return d.exp > Date.now() ? d : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set on the server.' });

  const secret = process.env.TOKEN_SECRET;
  if (secret) {
    if (!verifyToken(req.headers['x-auth-token'], secret)) {
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.', auth: true });
    }
  } else if (process.env.ACCESS_CODE && req.headers['x-access-code'] !== process.env.ACCESS_CODE) {
    return res.status(401).json({ error: 'Invalid access code.' });
  }

  const { system, messages, mode } = req.body || {};
  if (typeof system !== 'string' || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Bad request.' });
  }
  if (system.length > 40000 || JSON.stringify(messages).length > 200000) {
    return res.status(413).json({ error: 'Conversation too long.' });
  }

  const isReport = mode === 'report' || mode === 'parse';
  const model = isReport
    ? (process.env.REPORT_MODEL || 'claude-sonnet-5-5')
    : (process.env.CHAT_MODEL || 'claude-haiku-5-5');

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: mode === 'report' ? 4000 : mode === 'parse' ? 2500 : 500,
        system,
        messages,
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || 'Claude API error' });
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach the Claude API.' });
  }
}
