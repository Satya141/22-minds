// 22 Minds — tiny dependency-free server.
//  - serves /public
//  - POST /api/decide  -> routes a decision request to Jev (Vercel AI Gateway), Laya, or the built-in local model
//  - GET  /api/status  -> which providers are configured
// The AI Gateway key stays here on the server (.env), never in the browser.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { localDecide, describeState } = require('./local-model');

// ---- tiny .env loader -------------------------------------------------------
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env is fine: local model only */ }

const PORT = Number(process.env.PORT || 3000);
const GATEWAY = (process.env.AI_GATEWAY_BASE_URL || 'https://ai-gateway.vercel.sh/typesafe').replace(/\/$/, '');
const GATEWAY_KEY = process.env.AI_GATEWAY_API_KEY || '';
const JEV_MODEL = process.env.JEV_MODEL || 'typesafe-ai/jev';
const LAYA_BASE = (process.env.LAYA_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, ''); // local `laya-serve`
const LAYA_KEY = process.env.LAYA_API_KEY || '';
const LAYA_MODEL = process.env.LAYA_MODEL || 'convaiinnovations/laya-free'; // free on the gateway through 2026-10-31
const DEBUG = process.env.DEBUG_AI === '1';

const providers = {
  local: { label: 'Built-in heuristic', configured: true },
  jev: { label: 'Jev (AI Gateway)', configured: !!GATEWAY_KEY },
  laya: { label: 'Laya (local)', configured: false, via: '' },
};

// Laya: prefer a local `laya-serve` (free, offline); otherwise the AI Gateway's free Laya model.
let lastProbe = 0;
async function probeLaya() {
  if (Date.now() - lastProbe < 3000) return;
  lastProbe = Date.now();
  try {
    const r = await fetch(`${LAYA_BASE}/health`, { signal: AbortSignal.timeout(800) });
    if (r.ok) { providers.laya = { label: 'Laya (local)', configured: true, via: 'local' }; return; }
  } catch { /* not running */ }
  if (GATEWAY_KEY && LAYA_MODEL) providers.laya = { label: 'Laya (AI Gateway, free)', configured: true, via: 'gateway' };
  else providers.laya = { label: 'Laya (not running)', configured: false, via: '' };
}

// ---- remote call (TypeSafe-compatible /v1/systemone) ------------------------
async function remoteDecide(provider, state, questions) {
  let url, key, model;
  if (provider === 'jev') { url = `${GATEWAY}/v1/systemone`; key = GATEWAY_KEY; model = JEV_MODEL; }
  else if (providers.laya.via === 'local') { url = `${LAYA_BASE}/v1/systemone`; key = LAYA_KEY; model = undefined; }
  else { url = `${GATEWAY}/v1/systemone`; key = GATEWAY_KEY; model = LAYA_MODEL; }

  const body = { state, questions };
  if (model) body.model = model;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    if (DEBUG) console.log('[remote raw]', JSON.stringify(json).slice(0, 600));
    return json;
  } finally { clearTimeout(timer); }
}

// Normalise a remote answer into { choice, probs } per question.
function normalise(remote, questions) {
  const out = {};
  for (const id of Object.keys(questions)) {
    const a = remote.answers && remote.answers[id];
    if (!a) continue;
    const keys = Object.keys(questions[id].criteria || {});
    let probs = a.probabilities && Object.keys(a.probabilities).length ? { ...a.probabilities } : null;
    const choice = a.choice ?? a.answer ?? a.label ?? null;
    if (!probs && choice != null) {
      probs = {};
      const c = Number(a.confidence) > 0 ? Number(a.confidence) : 1;
      for (const k of keys) probs[k] = k === choice ? c : (1 - c) / Math.max(1, keys.length - 1);
    }
    if (probs) out[id] = { choice: choice ?? Object.entries(probs).sort((x, y) => y[1] - x[1])[0][0], probs };
  }
  return out;
}

async function decide({ provider, kind, facts, questions }) {
  const t0 = performance.now();
  if (provider === 'laya') await probeLaya();
  if (provider !== 'local' && providers[provider]?.configured) {
    try {
      const remote = await remoteDecide(provider, describeState(kind, facts), questions);
      const answers = normalise(remote, questions);
      if (Object.keys(answers).length === Object.keys(questions).length) {
        return { answers, prior: localDecide(kind, facts, questions), source: provider, latencyMs: Math.round(performance.now() - t0), cost: remote.provider_metadata?.gateway?.cost };
      }
      throw new Error('incomplete answers');
    } catch (err) {
      const answers = localDecide(kind, facts, questions);
      return { answers, source: 'local', fallbackFrom: provider, error: String(err.message || err),
               latencyMs: Math.round(performance.now() - t0) };
    }
  }
  const answers = localDecide(kind, facts, questions);
  return { answers, source: 'local', fallbackFrom: provider !== 'local' ? provider : undefined,
           error: provider !== 'local' ? 'provider not configured' : undefined,
           latencyMs: Math.round(performance.now() - t0) };
}

// ---- http -------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/api/status') {
      await probeLaya();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(providers));
    }
    if (req.method === 'POST' && url.pathname === '/api/decide') {
      const payload = JSON.parse(await readBody(req));
      const result = await decide(payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    }
    // static
    let file = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const full = path.normalize(path.join(__dirname, 'public', file));
    if (!full.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
}).listen(PORT, async () => {
  await probeLaya();
  console.log(`22 Minds running at http://localhost:${PORT}`);
  for (const [k, v] of Object.entries(providers)) console.log(`  ${v.label.padEnd(18)} ${v.configured ? 'ready' : 'not configured (falls back to local)'}`);
});
