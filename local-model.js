// Built-in decision model: a hand-tuned stand-in for Laya/Jev that needs no network.
// Same contract as the remote models: typed choice questions in, probabilities out.
const { footballDecide } = require('./local-football');

function localDecide(kind, facts, questions) {
  if (kind === 'football') return footballDecide(facts, questions);
  const out = {};
  for (const [id, q] of Object.entries(questions)) {
    const keys = Object.keys(q.criteria || {});
    out[id] = { choice: keys[0], probs: Object.fromEntries(keys.map((k) => [k, 1 / keys.length])) };
  }
  return out;
}

// Plain-English state for the real models (Laya/Jev read text).
function describeState(kind, f) {
  return kind === 'football' ? f.summary : '';
}

module.exports = { localDecide, describeState };
