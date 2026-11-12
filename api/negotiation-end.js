// POST /api/negotiation-end — ends the session, stores transcript/usage/outcome and hangs up the OpenAI call.
// Accepts navigator.sendBeacon bodies (page closed / refreshed).
const { send, fail, body, configured, onlyPost, gas, gasError, verify, hangup } = require('./_lib');

module.exports = async (req, res) => {
  if (!onlyPost(req, res)) return;
  if (!configured(res)) return;
  let b; try { b = await body(req); } catch (e) { return fail(res, 400, 'BAD_REQUEST', e.message); }
  if (!verify(b.sessionId, b.token)) return fail(res, 401, 'SESSION', 'Invalid session.');
  const transcript = Array.isArray(b.transcript) ? b.transcript.slice(0, 400).map(x => ({ who: x && x.who === 'ai' ? 'ai' : 'user', text: String((x && x.text) || '').slice(0, 1000), t: Number(x && x.t) || 0 })) : null;
  const u = b.usage && typeof b.usage === 'object' ? b.usage : null;
  const usage = u ? Object.fromEntries(['inAudio', 'inAudioCached', 'inText', 'inTextCached', 'outAudio', 'outText', 'responses'].map(k => [k, Math.max(0, Math.round(Number(u[k]) || 0))])) : null;
  const reason = ['user', 'time_up', 'network', 'unload', 'error', 'mic'].includes(b.reason) ? b.reason : 'user';
  try {
    const r = await gas('voice.end', { sessionId: b.sessionId, reason, transcript, usage });
    if (r.callId) await hangup(r.callId);
    send(res, 200, { ok: true, outcome: r.outcome, durationSec: r.durationSec, status: r.status, summary: r.summary });
  } catch (e) { gasError(res, e); }
};
