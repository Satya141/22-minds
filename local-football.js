// Football "prior": hand-tuned football sense for every player context.
// Same contract as the remote models: typed choice questions in, probabilities out.
// Questions are ids "p_<i>" (i = player index in the team); facts.players[i] carries the context + features.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function softmax(weights, sharp = 1.2) {
  const keys = Object.keys(weights);
  const m = Math.max(...keys.map((k) => weights[k]));
  const ex = keys.map((k) => Math.exp((weights[k] - m) * sharp));
  const s = ex.reduce((a, b) => a + b, 0);
  const out = {};
  keys.forEach((k, i) => { out[k] = ex[i] / s; });
  return out;
}

const scorers = {
  // ---- player with the ball ------------------------------------------------
  carrier(p) {
    const f = p.f;
    const w = { dribble: 0, pass_short: 0, pass_forward: 0, through_ball: 0, cross: -3, shoot: -3, hold: -0.8, clear: -4 };
    // shooting: close and central is good; long range or tight angle is not
    if (f.dGoal <= 12) w.shoot = 2.4; else if (f.dGoal <= 18) w.shoot = 1.6; else if (f.dGoal <= 24) w.shoot = 0.4; else if (f.dGoal <= 30) w.shoot = -0.8;
    if (f.wide && f.dGoal < 26) w.shoot -= 1.2;
    w.shoot += (f.shootSkill - 0.6) * 1.2 - f.pressure * 0.2;
    if (f.wide && f.attThird && f.dGoal > 14) w.cross = 1.7;
    w.through_ball = (f.attHalf ? f.throughOpen * 2.0 - 0.7 : -1.5);
    w.pass_forward = f.fwdOpen * 1.8 + (f.ownThird ? 0.2 : 0.4) - 0.5 + f.pressure * 0.4;
    w.pass_short = f.safeOpen * 1.3 + f.pressure * 1.4 + (f.ownThird ? 0.5 : 0);
    w.dribble = f.spaceAhead * 1.7 + f.dribSkill * 0.8 - f.pressure * 1.6 - (f.ownThird && f.pressure > 0.4 ? 1.5 : 0) + (f.attThird ? 0.2 : 0);
    if (f.ownThird && f.pressure > 0.6) w.clear = 2.0;
    return w;
  },
  gk_ball(p) {
    const f = p.f;
    return { throw_short: f.pressure < 0.5 ? 1.0 : -0.4, kick_long: f.pressure >= 0.5 ? 1.2 : 0.3 };
  },
  gk_pos(p) {
    const f = p.f;
    const w = { stay_line: 1.0, come_out: -1.5, sweep: 0 };
    if (f.ballLoose && f.dBall < 14) w.come_out = 2.2;
    if (f.oneOnOne) w.come_out = Math.max(w.come_out, 1.6);
    if (f.dBall > 35) w.sweep = 0.4;
    return w;
  },

  // ---- team has the ball, player does not ------------------------------------
  attack_off(p) {
    const f = p.f; const r = f.role;
    const w = { make_run: 0, support: 0.3, stay_wide: 0, hold_shape: 0.3 };
    if (r === 'ST') { w.make_run = 1.4 - (f.offsideRisk ? 2.2 : 0); w.support = 0.4; w.stay_wide = 0.1; }
    else if (r === 'W') { w.stay_wide = 1.4; w.make_run = f.attHalf ? 0.8 - (f.offsideRisk ? 2 : 0) : -0.2; w.support = 0.3; }
    else if (r === 'CM') { w.support = 1.0 - f.dCarrier / 40; w.make_run = f.attHalf && f.dCarrier < 30 ? 0.6 - (f.offsideRisk ? 2 : 0) : 0.0; w.stay_wide = -0.6; w.hold_shape = 0.2; }
    else if (r === 'FB') { w.hold_shape = 1.0; w.support = f.dCarrier < 22 ? 0.7 : 0.2; w.stay_wide = 0.4; w.make_run = f.attHalf ? 0.1 : -1.4; }
    else { w.hold_shape = 1.2; w.support = f.ownHalf && f.dCarrier < 22 ? 0.6 : 0.1; w.make_run = -1.6; w.stay_wide = -1; }
    return w;
  },

  // ---- opponent has the ball (or it is loose) --------------------------------
  defend_off(p) {
    const f = p.f; const r = f.role;
    const w = { press: -1.2, mark: 0, cover: 0.5, drop_back: -0.2, hold_shape: 0.5 };
    if (f.ballLoose) { w.press = f.rank === 0 ? 2.6 : f.rank === 1 ? 0.8 : -1.2; }
    else { w.press = f.rank === 0 ? 2.4 : f.rank === 1 && f.dBall < 18 ? 0.9 : -1.2; }
    if (f.markDist < 10) w.mark = 1.3 - f.markDist / 12 + (r === 'CB' || r === 'FB' ? 0.5 : 0);
    w.cover = f.rank <= 3 ? 0.8 : 0.4;
    if (f.dangerous) { w.cover += 0.6; w.drop_back = 1.2 + (r === 'CB' || r === 'FB' ? 0.4 : 0); w.press += f.rank === 0 ? 0 : -0.4; }
    if (r === 'ST') { w.hold_shape += 0.4; w.drop_back = -1; w.mark = -0.6; }
    return w;
  },
};

function footballDecide(facts, questions) {
  const out = {};
  for (const [id, q] of Object.entries(questions)) {
    const i = Number(id.slice(2));
    const p = facts.players[i];
    const opts = q.criteria || {};
    const keys = Object.keys(opts);
    const fn = p && scorers[p.ctx];
    if (!fn) { out[id] = { choice: keys[0], probs: Object.fromEntries(keys.map((k) => [k, 1 / keys.length])) }; continue; }
    const w = fn(p); const ww = {};
    for (const k of keys) ww[k] = w[k] != null ? w[k] : 0;
    const probs = softmax(ww);
    out[id] = { choice: Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0], probs };
  }
  return out;
}

module.exports = { footballDecide };
