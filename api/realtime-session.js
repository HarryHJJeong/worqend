// POST /api/realtime-session
// Verifies the participant on the WORQEND server (Apps Script), enforces 1 session / budget / allowlist,
// then creates the OpenAI Realtime call with the unified WebRTC interface (POST /v1/realtime/calls).
// The browser only receives the SDP answer — never an API key or an ephemeral key.
const crypto = require('crypto');
const { CFG, send, fail, body, configured, onlyPost, gas, gasError, sign, hangup } = require('./_lib');

module.exports = async (req, res) => {
  if (!onlyPost(req, res)) return;
  const c = configured(res); if (!c) return;
  let b; try { b = await body(req); } catch (e) { return fail(res, 400, 'BAD_REQUEST', e.message); }
  const sdp = typeof b.sdp === 'string' ? b.sdp : '';
  if (!sdp.startsWith('v=0') || sdp.length > 20000) return fail(res, 400, 'BAD_SDP', 'Invalid WebRTC offer.');
  const who = { loginId: String(b.loginId || '').slice(0, 120), password: String(b.password || '').slice(0, 200), projectId: String(b.projectId || '').slice(0, 120), scenarioId: String(b.scenarioId || 'brooks-renewal').slice(0, 60), model: c.model };

  // 1) WORQEND checks: login, project, allowlist, one session per person, global concurrency, monthly budget
  let start;
  try {
    start = await gas('voice.start', who);
    if (start && start.conflict === 'SELF') {                       // the same person refreshed / opened a second tab
      await Promise.all((start.sessions || []).map(s => hangup(s.callId)));
      start = await gas('voice.start', { ...who, replace: true });
    }
  } catch (e) { return gasError(res, e); }

  // 2) OpenAI call (private config stays on the server)
  const session = {
    type: 'realtime',
    model: c.model,
    instructions: `${start.instructions}\n\n${start.opening || ''}`.trim(),
    output_modalities: ['audio'],
    audio: {
      input: {
        transcription: { model: c.transcribe, language: 'en' },
        turn_detection: { type: 'semantic_vad', eagerness: 'auto', create_response: true, interrupt_response: true },
        noise_reduction: { type: 'near_field' }
      },
      output: { voice: c.voice }
    },
    tools: start.tools,
    tool_choice: 'auto',
    max_output_tokens: 1024
  };
  const fd = new FormData();
  fd.set('sdp', sdp);
  fd.set('session', JSON.stringify(session));
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  let answer, callId;
  try {
    const r = await fetch(`${c.openaiBase}/realtime/calls`, {
      method: 'POST', body: fd, signal: ctl.signal,
      headers: { Authorization: `Bearer ${c.openaiKey}`, 'OpenAI-Safety-Identifier': crypto.createHash('sha256').update(start.participant.id).digest('hex').slice(0, 32) }
    });
    if (!r.ok) { const detail = (await r.text()).slice(0, 500); throw new Error(`OpenAI ${r.status}: ${detail}`); }
    answer = await r.text();
    callId = (r.headers.get('location') || '').split('/').pop();
  } catch (e) {
    console.error('OpenAI call creation failed:', e.message);
    gas('voice.fail', { sessionId: start.sessionId, error: e.message }).catch(() => {});
    return fail(res, 502, 'OPENAI', 'Could not connect to the AI voice service. Please try again in a moment.');
  } finally { clearTimeout(t); }

  // 3) Mark active (start of the 10-minute clock on the server)
  let att;
  try { att = await gas('voice.attach', { sessionId: start.sessionId, callId }); }
  catch (e) { await hangup(callId); gas('voice.fail', { sessionId: start.sessionId, error: 'attach: ' + e.message }).catch(() => {}); return gasError(res, e); }

  send(res, 200, { ok: true, sdp: answer, sessionId: start.sessionId, token: sign(start.sessionId), maxSeconds: start.maxSeconds, endsAt: att.endsAt, scenario: start.scenario, model: c.model });
};
