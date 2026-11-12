// POST /api/negotiation-tool — the model's tool calls are judged by WORQEND server rules (Apps Script).
// The browser relays the call; the hidden conditions never leave the server.
const { send, fail, body, configured, onlyPost, gas, gasError, verify } = require('./_lib');
const TOOLS = ['evaluate_offer', 'get_guidance', 'close_negotiation'];

module.exports = async (req, res) => {
  if (!onlyPost(req, res)) return;
  if (!configured(res)) return;
  let b; try { b = await body(req); } catch (e) { return fail(res, 400, 'BAD_REQUEST', e.message); }
  if (!verify(b.sessionId, b.token)) return fail(res, 401, 'SESSION', 'Invalid session.');
  if (!TOOLS.includes(b.name)) return fail(res, 400, 'TOOL', 'Unknown tool.');
  const args = b.args && typeof b.args === 'object' ? b.args : {};
  if (JSON.stringify(args).length > 4000) return fail(res, 400, 'TOOL', 'Arguments too large.');
  try { const r = await gas('voice.tool', { sessionId: b.sessionId, name: b.name, args }); send(res, 200, { ok: true, output: r.output }); }
  catch (e) { gasError(res, e); }
};
