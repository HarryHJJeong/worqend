// POST /api/realtime-sweep — called every minute by an Apps Script time trigger (voiceSweepTick).
// Hangs up OpenAI calls that went past the 10-minute limit, even if the browser never ended them.
const { send, fail, body, configured, gas, gasError, secretOk, hangup } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return fail(res, 405, 'METHOD', 'POST only');
  if (!configured(res)) return;
  let b; try { b = await body(req); } catch (e) { return fail(res, 400, 'BAD_REQUEST', e.message); }
  if (!secretOk(b.secret)) return fail(res, 403, 'FORBIDDEN', 'Forbidden');
  try {
    const r = await gas('voice.sweep', {});
    const done = await Promise.all((r.hangup || []).map(hangup));
    send(res, 200, { ok: true, hungUp: done.filter(Boolean).length, total: (r.hangup || []).length });
  } catch (e) { gasError(res, e); }
};
