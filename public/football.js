'use strict';
// 22 Minds — every player (all 22) asks a decision model what to do every ~350 ms.
// The engine owns physics and the laws of the game; the model only chooses *what* each player does.

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const hyp = Math.hypot;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------- constants
const HL = 52.5, HW = 34, GOAL = 3.66, PEN_X = HL - 16.5, PEN_Y = 20.16;
const G = 9.8, DT = 1 / 60, ROLL = 1.4;
const TEAMS = [
  { name: 'Blue Titans', short: 'BLT', color: '#3b82f6', light: '#bfdbfe', gk: '#06b6d4' },
  { name: 'Gold Royals', short: 'GLD', color: '#f5b942', light: '#fde68a', gk: '#f97316' },
];
// 4-4-2 in the team's own frame: +x is toward the opponent's goal.
const FORM = [
  { role: 'GK', label: 'GK', x: -48, y: 0 },
  { role: 'FB', label: 'LB', x: -33, y: -23 }, { role: 'CB', label: 'CB', x: -36, y: -8 }, { role: 'CB', label: 'CB', x: -36, y: 8 }, { role: 'FB', label: 'RB', x: -33, y: 23 },
  { role: 'W', label: 'LM', x: -12, y: -25 }, { role: 'CM', label: 'CM', x: -17, y: -8 }, { role: 'CM', label: 'CM', x: -17, y: 8 }, { role: 'W', label: 'RM', x: -12, y: 25 },
  { role: 'ST', label: 'ST', x: 6, y: -9 }, { role: 'ST', label: 'ST', x: 7, y: 9 },
];
const NUMS = [1, 3, 5, 4, 2, 11, 8, 6, 7, 9, 10];

// ---------------------------------------------------------------- questions (what the models see)
const OPTS = {
  carrier: { dribble: 'Run forward with the ball', pass_short: 'Pass safely to a nearby teammate', pass_forward: 'Pass forward to a teammate in a good position',
    through_ball: 'Play a through ball into space behind the defence', cross: 'Cross the ball into the penalty area from the wing', shoot: 'Shoot at goal',
    hold: 'Shield the ball and wait for support', clear: 'Clear the ball away from danger' },
  gk_ball: { throw_short: 'Roll or throw the ball short to a defender', kick_long: 'Kick the ball long upfield' },
  gk_pos: { stay_line: 'Stay on the goal line', come_out: 'Rush out to claim or clear the ball', sweep: 'Stand outside the box as a sweeper' },
  attack_off: { make_run: 'Sprint forward into space behind the defence', support: 'Move closer to the ball carrier to offer a pass',
    stay_wide: 'Stay wide and stretch the defence', hold_shape: 'Hold position in the team formation' },
  defend_off: { press: 'Close down the ball carrier or chase the loose ball', mark: 'Stay close to the nearest opponent', cover: 'Drop to cover the space between the ball and goal',
    drop_back: 'Retreat toward your own goal', hold_shape: 'Hold position in the team formation' },
};

// ---------------------------------------------------------------- rng
let rngState = 1;
function rnd() { rngState = (rngState + 0x6D2B79F5) >>> 0; let t = rngState; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const rr = (a, b) => lerp(a, b, rnd());
const gauss = () => { let u = 0; for (let i = 0; i < 4; i++) u += rnd(); return (u - 2) / 0.58; };

// ---------------------------------------------------------------- state
let providersStatus = { local: { configured: true, label: 'Built-in heuristic' } };
const GAME_SPEED = 2;   // fixed playback speed (the simulation runs at 2x real time)
let M = null, paused = false, speed = GAME_SPEED, lastTs = 0, acc = 0, flash = null;
const cv = $('#pitch'), ctx = cv.getContext('2d');
let CW = 1000, CH = 650, SC = 9, DPR = 1;
function sizeCanvas() {
  const r = cv.getBoundingClientRect(); DPR = Math.min(window.devicePixelRatio || 1, 2);
  CW = Math.max(300, Math.round(r.width)); CH = Math.max(200, Math.round(r.height));
  cv.width = CW * DPR; cv.height = CH * DPR; ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  SC = Math.min(CW / (2 * HL + 5), CH / (2 * HW + 5));
}
window.addEventListener('resize', sizeCanvas);
const sx = (x) => CW / 2 + x * SC, sy = (y) => CH / 2 + y * SC;

const dirOf = (t) => M.dir[t];
const teamOf = (t) => M.players.filter((p) => p.team === t && !p.red);
const gkOf = (t) => M.players[t * 11];
const periodInfo = () => (M.half <= 2 ? { base: M.half === 1 ? 0 : 45, len: 45, per: M.halfLen } : { base: M.half === 3 ? 90 : 105, len: 15, per: M.halfLen / 3 });
const addedMin = () => Math.max(1, Math.min(6, Math.ceil(M.stop || 0)));
const minute = () => { const i = periodInfo(); return i.base + Math.min(i.len, Math.floor(M.t / i.per * i.len)); };
function clockText() {
  if (M.phase === 'over') return 'FT';
  if (M.phase === 'shootout') return 'PENS';
  const i = periodInfo(); const m = Math.floor(M.t / i.per * i.len);
  return m >= i.len ? `${i.base + i.len}+${m - i.len + 1}'` : `${i.base + m + 1}'`;
}

// ---------------------------------------------------------------- provider calls
const providerName = (p) => (providersStatus[p] ? providersStatus[p].label : p);
function sample(probs, sharp = 1.5) {
  const keys = Object.keys(probs); const w = keys.map((k) => Math.pow(Math.max(probs[k], 1e-6), sharp)); const s = w.reduce((a, b) => a + b, 0);
  let r = rnd() * s; for (let i = 0; i < keys.length; i++) { r -= w[i]; if (r <= 0) return keys[i]; } return keys[keys.length - 1];
}
const choose = (ans) => (ans && ans.probs ? sample(ans.probs) : ans && ans.choice);

function blend(res, questions) {
  const a = M.influence;
  if (!res.prior || a >= 0.999) return res;
  const out = {};
  for (const qid of Object.keys(questions)) {
    const m = res.answers[qid], p = res.prior[qid];
    if (!m || !p) { out[qid] = m || p; continue; }
    const keys = Object.keys(m.probs); let sum = 0; const pr = {};
    for (const k of keys) { pr[k] = Math.pow(Math.max(m.probs[k], 1e-4), a) * Math.pow(Math.max((p.probs && p.probs[k]) || 1e-4, 1e-4), 1 - a); sum += pr[k]; }
    for (const k of keys) pr[k] /= sum;
    out[qid] = { choice: Object.entries(pr).sort((x, y) => y[1] - x[1])[0][0], probs: pr, model: m.choice };
  }
  return { ...res, answers: out, blended: true };
}

async function decide(teamIdx, facts, questions) {
  const provider = M.providers[teamIdx]; const st = M.tel[teamIdx]; const id = M.id; let res;
  try {
    const r = await fetch('/api/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, kind: 'football', facts, questions }) });
    res = await r.json();
    if (!r.ok || (res.error && !res.answers)) throw new Error(res.error || 'request failed');
  } catch (e) {
    const answers = {};
    for (const [k, q] of Object.entries(questions)) { const keys = Object.keys(q.criteria); answers[k] = { choice: keys[0], probs: Object.fromEntries(keys.map((x) => [x, 1 / keys.length])) }; }
    res = { answers, source: 'local', fallbackFrom: provider, error: String(e.message), latencyMs: 0 };
  }
  if (id !== M.id) return null;
  st.calls++; st.ms += res.latencyMs || 0; st.maxMs = Math.max(st.maxMs, res.latencyMs || 0);
  if (res.source !== provider) st.fallbacks++;
  st.lastErr = res.error || '';
  return blend(res, questions);
}

// ---------------------------------------------------------------- match setup
function makePlayers() {
  const out = [];
  for (let t = 0; t < 2; t++) for (let i = 0; i < 11; i++) {
    const f = FORM[i], fw = f.role === 'ST' || f.role === 'W', df = f.role === 'CB' || f.role === 'FB', gk = f.role === 'GK';
    out.push({ id: t * 11 + i, team: t, i, role: f.role, label: f.label, num: NUMS[i], x: 0, y: 0, vx: 0, vy: 0, face: 0,
      pace: rr(fw ? 7.6 : 6.9, fw ? 8.8 : 8.0), pass: rr(f.role === 'CM' ? 0.72 : 0.55, f.role === 'CM' ? 0.92 : 0.85), shoot: rr(fw ? 0.62 : 0.35, fw ? 0.92 : 0.7),
      tackle: rr(df ? 0.62 : 0.45, df ? 0.9 : 0.78), drib: rr(fw ? 0.6 : 0.4, fw ? 0.9 : 0.75), gk: gk ? rr(0.6, 0.88) : 0,
      action: 'hold_shape', prob: 0, ctx: '', pending: null, tackleCd: 0, ctrlCd: 0, stun: 0, yellow: 0, red: false, recv: null, holdT: 0 });
  }
  return out;
}

function newMatch() {
  const id = (M ? M.id : 0) + 1;
  rngState = (Date.now() ^ (id * 2654435761)) >>> 0;
  M = { id, providers: ['laya', 'laya'], influence: 1, halfLen: Number($('#lenSel').value),   // both teams use Laya (the server falls back to the built-in model if Laya is not running)
   
    half: 1, t: 0, stop: 0, pens: null, knockout: $('#modeSel').value === 'ko', score: [0, 0], dir: [1, -1], phase: 'restart', timer: 1, players: makePlayers(), restart: null,
    ball: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, owner: null, lastTouch: null, lastTeam: 0, shot: false, shotTeam: 0, saveTried: false, flight: null, trail: [] },
    stats: [0, 1].map(() => ({ poss: 0, shots: 0, onTarget: 0, passes: 0, passOk: 0, fouls: 0, yellow: 0, red: 0, corners: 0, offsides: 0 })),
    tel: [0, 1].map(() => ({ calls: 0, ms: 0, maxMs: 0, fallbacks: 0, lastErr: '' })),
    inflight: [false, false], tickT: [0, 0], last: [null, null], goals: [] };
  $('#overlay').hidden = true; $('#commentary').innerHTML = '';
  $('#setupCard').hidden = true; $('#lineCard').hidden = false; $('#statsCard').hidden = false; $('#telCard').hidden = false;
  $('#tnameA').textContent = TEAMS[0].name; $('#tnameB').textContent = TEAMS[1].name;
  addComment(0, `Kick-off! <b>${TEAMS[0].name}</b> (${providerLabel(0)}) v <b>${TEAMS[1].name}</b> (${providerLabel(1)}).`);
  kickoff(0, true);
  renderStats();
}
const providerLabel = (t) => (M.providers[t] === 'local' ? 'built-in model' : providerName(M.providers[t]));

function homeOf(p) {
  const d = dirOf(p.team), f = FORM[p.i], b = M.ball;
  const rel = b.x * d; const poss = b.owner ? (b.owner.team === p.team ? 1 : -1) : 0;
  // the whole team moves with the ball: up the pitch when attacking, back when defending, and sliding toward the ball side
  const push = p.role === 'ST' ? 0.62 : p.role === 'W' || p.role === 'CM' ? 0.55 : 0.4;
  const shift = p.i === 0 ? clamp(rel * 0.1, -2, 6) : clamp(rel * push, -18, 26) + poss * (p.role === 'CB' ? 2 : 6);
  const slide = p.i === 0 ? 0 : clamp(b.y * 0.32, -12, 12) * (p.role === 'ST' ? 0.6 : 1);
  return { x: clamp(d * (f.x + shift), -HL + 1.5, HL - 1.5), y: clamp(d * f.y * 0.95 + slide, -HW + 2, HW - 2) };
}

function kickoff(team, first) {
  M.phase = 'restart'; M.timer = first ? 1.6 : 1.4; M.restart = { kind: 'kickoff', team };
  const b = M.ball; b.x = b.y = b.z = b.vx = b.vy = b.vz = 0; b.shot = false; b.flight = null; b.owner = null; b.trail = [];
  for (const p of M.players) {
    const f = FORM[p.i], d = dirOf(p.team);
    p.x = d * Math.min(f.x, -1.5); p.y = d * f.y; p.vx = p.vy = 0; p.action = 'hold_shape'; p.pending = null; p.recv = null; p.stun = 0;
    if (p.red) { p.x = 0; p.y = HW + 6; }
  }
  const taker = M.players[team * 11 + 10];
  taker.x = -dirOf(team) * 0.6; taker.y = 0; b.x = 0; b.y = 0; b.owner = taker; b.lastTouch = taker; b.lastTeam = team; taker.action = 'hold'; M.freshRestart = 'kickoff';
  for (const p of teamOf(1 - team)) { const r = hyp(p.x, p.y); if (r < 9.5) { const k = 9.6 / (r || 1); p.x *= k; p.y *= k; } }
}

// ---------------------------------------------------------------- geometry helpers
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
  return { d: hyp(px - (ax + dx * t), py - (ay + dy * t)), t };
}
function laneOpen(a, tx, ty, team) {
  let md = 99;
  for (const o of teamOf(1 - team)) { const r = distToSeg(o.x, o.y, a.x, a.y, tx, ty); if (r.t > 0.08 && r.t < 0.97 && r.d < md) md = r.d; }
  return clamp((md - 1) / 5, 0, 1);
}
function nearestOpp(p) { let best = null, bd = 99; for (const o of teamOf(1 - p.team)) { const d = hyp(o.x - p.x, o.y - p.y); if (d < bd) { bd = d; best = o; } } return { o: best, d: bd }; }
function offsideLine(team) {   // x*dir of the second-last opposing player, or the ball if further up
  const d = dirOf(team); const xs = teamOf(1 - team).map((o) => o.x * d).sort((a, b) => b - a);
  return Math.max(M.ball.x * d, xs[1] != null ? xs[1] : 0, 0);
}

// ---------------------------------------------------------------- decisions
function buildFacts(t) {
  const b = M.ball, d = dirOf(t), mine = teamOf(t);
  const owner = b.owner; const hasBall = owner && owner.team === t; const loose = !owner;
  const flightMine = b.flight && b.flight.team === t;
  const gx = d * HL, ownGx = -d * HL; const oLine = offsideLine(t);
  const byBall = mine.filter((p) => p.i !== 0).sort((a, c) => hyp(a.x - b.x, a.y - b.y) - hyp(c.x - b.x, c.y - b.y));
  const players = [], questions = {};
  const mate = (p) => mine.filter((q) => q !== p);
  for (const p of M.players.slice(t * 11, t * 11 + 11)) {
    if (p.red) { players.push({ ctx: 'none', f: {} }); continue; }
    const dBall = hyp(p.x - b.x, p.y - b.y), no = nearestOpp(p);
    let c, f, text;
    const tag = `${TEAMS[t].short} #${p.num} ${p.label}`;
    if (owner === p) {
      if (p.i === 0) { c = 'gk_ball'; f = { pressure: clamp(1 - no.d / 8, 0, 1) }; text = `${tag} has the ball in his hands${f.pressure > 0.5 ? ', an opponent is closing in' : ''}. What should he do?`; }
      else {
        c = 'carrier';
        let fwd = 0, safe = 0, thr = 0;
        for (const q of mate(p)) {
          const dx = (q.x - p.x) * d; const dist = hyp(q.x - p.x, q.y - p.y); if (dist < 4) continue;
          const open = laneOpen(p, q.x, q.y, t); const off = q.x * d > oLine + 0.5;
          if (dx > 3) fwd = Math.max(fwd, open * (off ? 0.2 : 1));
          if (dist < 26) safe = Math.max(safe, open);
          if (dx > 9) thr = Math.max(thr, laneOpen(p, q.x + d * 8, q.y, t) * (off ? 0.25 : 1));
        }
        let md = 99; for (const o of teamOf(1 - t)) { const ax = (o.x - p.x) * d, ay = o.y - p.y; if (ax > 0 && Math.abs(ay) < ax * 1.1 + 1) md = Math.min(md, hyp(ax, ay)); }
        const dGoal = hyp(gx - p.x, p.y), dOwn = hyp(ownGx - p.x, p.y);
        f = { dGoal, pressure: clamp(1 - no.d / 3.5, 0, 1), fwdOpen: fwd, safeOpen: safe, throughOpen: thr, spaceAhead: clamp(md / 10, 0, 1), wide: Math.abs(p.y) > 22,
          attThird: dGoal < 38, attHalf: p.x * d > -3, ownThird: dOwn < 35, shootSkill: p.shoot, dribSkill: p.drib };
        text = `${tag} has the ball ${dGoal.toFixed(0)} m from goal${f.wide ? ' on the wing' : ''}${f.pressure > 0.5 ? ', closed down' : ''}${fwd > 0.6 ? ', a teammate is free ahead' : ''}. What should he do?`;
      }
    } else if (p.i === 0) {
      c = 'gk_pos';
      const threat = owner && owner.team !== t && hyp(ownGx - owner.x, owner.y) < 20;
      f = { dBall, ballLoose: loose, oneOnOne: !!threat };
      text = `${tag} is the goalkeeper; the ball is ${dBall.toFixed(0)} m away${loose ? ' and loose' : ''}${threat ? ', an attacker is through on goal' : ''}. What should he do?`;
    } else if (hasBall || flightMine) {
      c = 'attack_off';
      const ref = owner || b;
      f = { role: p.role, dCarrier: hyp(p.x - ref.x, p.y - ref.y), attHalf: p.x * d > 0, ownHalf: p.x * d <= 0, offsideRisk: p.x * d > oLine - 1.2 };
      text = `${tag}, your team has the ball ${f.dCarrier.toFixed(0)} m away${f.offsideRisk ? '; you are near the offside line' : ''}. What should you do?`;
    } else {
      c = 'defend_off';
      const rank = byBall.indexOf(p);
      let md = 99; for (const o of teamOf(1 - t)) { if (o === owner) continue; md = Math.min(md, hyp(o.x - p.x, o.y - p.y)); }
      f = { role: p.role, rank, dBall, ballLoose: loose, dangerous: hyp(b.x - ownGx, b.y) < 30, markDist: md };
      text = `${tag}, ${loose ? 'the ball is loose' : 'the opponent has the ball'}, ${dBall.toFixed(0)} m away, you are #${rank + 1} closest${f.dangerous ? ' and the ball is near your goal' : ''}. What should you do?`;
    }
    players.push({ ctx: c, f, label: tag, role: p.role });
    questions['p_' + p.i] = { type: 'choice', instructions: text, criteria: OPTS[c] };
    p.ctx = c;
  }
  const lead = M.score[t] - M.score[1 - t];
  const summary = `Football match, minute ${minute()}. ${TEAMS[t].name} ${M.score[t]}, ${TEAMS[1 - t].name} ${M.score[1 - t]} (${lead > 0 ? 'leading' : lead < 0 ? 'trailing' : 'level'}). ${hasBall ? 'Your team has the ball.' : loose ? 'The ball is loose.' : 'The opponent has the ball.'}`;
  return { facts: { summary, players }, questions };
}

async function tickTeam(t) {
  if (M.inflight[t]) return;
  const id = M.id; M.inflight[t] = true;
  const { facts, questions } = buildFacts(t);
  const res = await decide(t, facts, questions);
  M.inflight[t] = false;
  if (!res || id !== M.id) return;
  const picks = [];
  for (const p of M.players.slice(t * 11, t * 11 + 11)) {
    const ans = res.answers['p_' + p.i]; if (!ans || p.red) continue;
    const a = choose(ans); p.action = a; p.prob = ans.probs ? ans.probs[a] : 1;
    if (p.ctx === 'carrier' || p.ctx === 'gk_ball') { if (M.ball.owner === p) p.pending = a; }
    else if (p.pending) p.pending = null;
    picks.push({ i: p.i, p, action: a, prob: p.prob, ctx: p.ctx, ans });
  }
  M.last[t] = { picks, res }; renderTeamDecisions(t);
}

// ---------------------------------------------------------------- ball actions
function launch(p, tx, ty, vend, lofted, target, kind) {
  const b = M.ball; const dx = tx - p.x, dy = ty - p.y, dist = hyp(dx, dy) || 1;
  const err = gauss() * (1.2 - p.pass) * 0.034 * (1 + dist / 28) * (kind === 'long' ? 1.6 : 1);
  const a = Math.atan2(dy, dx) + err;
  let sp, vz = 0;
  if (lofted) { const T = clamp(dist / 17, 0.9, 2.2); vz = G * T / 2; sp = dist / T; b.z = 0.3; }
  else { sp = Math.min(30, Math.sqrt(vend * vend + 2 * ROLL * dist)); b.z = 0.1; }
  b.x = p.x + Math.cos(a) * 0.8; b.y = p.y + Math.sin(a) * 0.8; b.vx = Math.cos(a) * sp; b.vy = Math.sin(a) * sp; b.vz = vz;
  b.owner = null; b.lastTouch = p; b.lastTeam = p.team; b.shot = false; b.saveTried = false; b.lofted = !!lofted; p.ctrlCd = 0.6; p.pending = null; p.action = 'hold_shape';
  const off = new Set();
  const exempt = ['throw', 'goalkick', 'corner'].includes(M.freshRestart); M.freshRestart = null;
  if (target) {
    const d = dirOf(p.team), line = offsideLine(p.team);
    if (!exempt) for (const q of teamOf(p.team)) if (q !== p && q.x * d > line + 0.3 && q.x * d > 0) off.add(q.id);
    target.recv = { x: tx, y: ty, until: M.t + 2.4 }; target.action = 'receive';
    M.stats[p.team].passes++;
  }
  b.flight = { passer: p, target, team: p.team, offside: off, t0: M.t }; b.lastFlight = null;
}

function pickTarget(p, kind) {
  const d = dirOf(p.team); let best = null, bs = -1e9;
  for (const q of teamOf(p.team)) {
    if (q === p) continue;
    const dx = (q.x - p.x) * d, dist = hyp(q.x - p.x, q.y - p.y); if (dist < 4) continue;
    if (kind === 'through' && dx < 8) continue;
    const tx = kind === 'through' ? q.x + d * 8 : q.x, ty = q.y;
    let sc = laneOpen(p, tx, ty, p.team) * 3;
    if (kind === 'forward') sc += (dx > 3 ? Math.min(dx, 18) / 18 : -1.5) - Math.max(0, dist - 17) / 5;
    else if (kind === 'short') sc += 1 - Math.abs(dist - 10) / 8 - Math.max(0, dist - 16) / 4;
    else if (kind === 'through') sc += dx / 15;
    else if (kind === 'gk') sc += (q.role === 'CB' || q.role === 'FB' ? 1 : 0) - dist / 40;
    for (const o of teamOf(1 - p.team)) if (hyp(o.x - q.x, o.y - q.y) < 4) sc -= 0.8;
    if (q.x * d > offsideLine(p.team) + 0.5) sc -= 1.6;
    if (sc > bs) { bs = sc; best = q; }
  }
  return best;
}

function doPass(p, kind) {
  const q = pickTarget(p, kind); if (!q) { p.action = 'dribble'; return; }
  const d = dirOf(p.team);
  const tx = kind === 'through' ? q.x + d * 8 : q.x + q.vx * 0.4, ty = q.y + q.vy * 0.4;
  launch(p, tx, ty, kind === 'through' ? 7 : 8, false, q, kind);
  if (kind === 'through') addComment(minute(), `${TEAMS[p.team].short} #${p.num} threads a through ball for #${q.num}.`);
}

function doCross(p) {
  const d = dirOf(p.team); const side = p.y > 0 ? -1 : 1;
  const tx = d * (HL - 9), ty = side * rr(1, 5);
  let q = null, bd = 99; for (const m of teamOf(p.team)) { if (m === p) continue; const r = hyp(m.x - tx, m.y - ty); if (r < bd) { bd = r; q = m; } }
  launch(p, tx, ty, 0, true, q, 'cross');
  addComment(minute(), `${TEAMS[p.team].short} #${p.num} whips in a cross.`);
}

function doClear(p) { const d = dirOf(p.team); launch(p, p.x + d * 38, clamp(p.y * 1.3, -30, 30), 0, true, null, 'long'); M.ball.flight = null; }

function doKickLong(p) {
  const d = dirOf(p.team); const q = teamOf(p.team).filter((m) => m.role === 'ST' || m.role === 'W').sort((a, c) => (c.x * d) - (a.x * d))[0];
  launch(p, q ? q.x : d * 10, q ? q.y : 0, 0, true, q || null, 'long');
}

function doShoot(p) {
  const d = dirOf(p.team), gx = d * HL, gk = gkOf(1 - p.team); const dist = hyp(gx - p.x, p.y);
  const side = (gk.y > 0 ? -1 : 1) * (rnd() < 0.7 ? 1 : -1);
  const aimY = side * rr(1.2, 3.1) + gauss() * (1.25 - p.shoot) * (0.6 + dist / 14);
  const sp = rr(22, 31) * (0.85 + 0.3 * p.shoot), a = Math.atan2(aimY - p.y, gx - p.x);
  const b = M.ball; b.x = p.x + Math.cos(a) * 0.8; b.y = p.y + Math.sin(a) * 0.8; b.z = 0.2; b.vx = Math.cos(a) * sp; b.vy = Math.sin(a) * sp;
  b.vz = rnd() < 0.18 ? rr(2.5, 6) : rr(0, 2.2) + (1.25 - p.shoot) * rr(0, 3);
  b.owner = null; b.lastTouch = p; b.lastTeam = p.team; b.shot = true; b.shotTeam = p.team; b.saveTried = false; b.flight = null;
  p.ctrlCd = 0.6; p.pending = null; p.action = 'hold_shape'; M.stats[p.team].shots++;
  addComment(minute(), `${TEAMS[p.team].short} #${p.num} shoots from ${dist.toFixed(0)} m!`);
}

function execute(p, act) {
  const rk = M.restart && M.restart.kind;
  if (p.setPiece) {            // set pieces: sensible remaps
    if (rk === 'throw' && (act === 'dribble' || act === 'hold' || act === 'shoot' || act === 'clear')) act = 'pass_short';
    if (rk === 'corner' && ['dribble', 'hold', 'shoot', 'pass_short', 'pass_forward', 'through_ball'].includes(act)) act = 'cross';
    p.setPiece = false;
  }
  if (act === 'shoot' && hyp(dirOf(p.team) * HL - p.x, p.y) > 45) act = 'pass_forward';   // nobody shoots from 45+ m: play a pass instead
  switch (act) {
    case 'shoot': return doShoot(p);
    case 'pass_short': return doPass(p, 'short');
    case 'pass_forward': return doPass(p, 'forward');
    case 'through_ball': return doPass(p, 'through');
    case 'cross': return doCross(p);
    case 'clear': return doClear(p);
    case 'throw_short': return doPass(p, 'gk');
    case 'kick_long': return doKickLong(p);
    default: return;           // dribble / hold: handled by movement
  }
}

// ---------------------------------------------------------------- movement
function ballFuture(t) {
  const b = M.ball; const sp = hyp(b.vx, b.vy); if (sp < 0.05) return { x: b.x, y: b.y };
  const tt = Math.min(t, sp / ROLL); const dd = sp * tt - 0.5 * ROLL * tt * tt; return { x: b.x + b.vx / sp * dd, y: b.y + b.vy / sp * dd };
}

// Each role keeps to its own zone: how far a player may roam from his formation slot (metres).
const LEASH = { GK: 12, CB: 22, FB: 30, CM: 36, W: 38, ST: 42 };

function updateRanks() {
  const b = M.ball;
  for (let t = 0; t < 2; t++) {
    const mates = teamOf(t).filter((q) => q.i !== 0).sort((a, c) => hyp(a.x - b.x, a.y - b.y) - hyp(c.x - b.x, c.y - b.y));
    mates.forEach((q, r) => { q.brank = r; });
  }
}

// One marker per opponent: pair each outfield player with the opponent nearest his own slot, greedily and without sharing.
function assignMarks() {
  for (let t = 0; t < 2; t++) {
    const mine = teamOf(t).filter((q) => q.i !== 0), theirs = teamOf(1 - t).filter((o) => o.i !== 0);
    const pairs = [];
    for (const q of mine) { const h = homeOf(q); for (const o of theirs) pairs.push([hyp(h.x - o.x, h.y - o.y), q, o]); }
    pairs.sort((a, c) => a[0] - c[0]);
    const usedQ = new Set(), usedO = new Set();
    for (const [, q, o] of pairs) { if (usedQ.has(q.id) || usedO.has(o.id)) continue; q.markId = o.id; usedQ.add(q.id); usedO.add(o.id); }
  }
}

function ensureChasers() {
  for (const q of M.players) q.chaser = false;
  const b = M.ball; if (b.owner) return;
  const fl = b.flight;
  const f = ballFuture(0.4);
  for (let t = 0; t < 2; t++) {
    if (fl && fl.team === t) continue;            // our own pass in the air: the receiver deals with it
    let best = null, bd = 1e9;
    for (const q of teamOf(t)) { if (q.i === 0) continue; const d = hyp(q.x - f.x, q.y - f.y); if (d < bd) { bd = d; best = q; } }
    const gk = gkOf(t);
    if (!gk.red && Math.abs(f.x) > PEN_X && Math.abs(f.y) < PEN_Y && Math.sign(f.x) === -M.dir[t] && hyp(gk.x - f.x, gk.y - f.y) <= bd) { gk.action = 'come_out'; continue; }
    if (best && best.action !== 'receive') { best.action = 'press'; best.chaser = true; }
  }
}

function targetFor(p) {
  const b = M.ball, d = dirOf(p.team), home = homeOf(p), owner = b.owner, goalC = { x: -d * HL, y: 0 };
  const oppGoal = { x: d * HL, y: 0 };
  let act = p.action;
  if (act === 'press' && !p.chaser && (p.brank === undefined || p.brank > 1)) act = 'cover';   // only the two nearest players close the ball down
  switch (act) {
    case 'receive': if (p.recv && M.t < p.recv.until) return { x: p.recv.x, y: p.recv.y, sp: 1 }; p.action = 'hold_shape'; return { ...home, sp: 0.6 };
    case 'press': {
      if (owner && owner.team !== p.team) return { x: owner.x + owner.vx * 0.25, y: owner.y + owner.vy * 0.25, sp: 1 };
      const fl = b.flight;   // only a pass still travelling counts; a slowed-down ball is simply loose
      if (fl && fl.team !== p.team && fl.target && !fl.target.red) return { x: fl.target.x, y: fl.target.y, sp: 1 };   // close down the receiver, not the ball
      const f = ballFuture(0.35); return { x: f.x, y: f.y, sp: 1 };
    }
    case 'mark': {
      let best = M.players[p.markId];
      if (!best || best.red || best.team === p.team) { let bd = 99; best = null; for (const o of teamOf(1 - p.team)) { if (o.i === 0) continue; const r = hyp(o.x - p.x, o.y - p.y); if (r < bd) { bd = r; best = o; } } }
      if (!best) return { ...home, sp: 0.6 };
      const gx = goalC.x - best.x, gy = goalC.y - best.y, gl = hyp(gx, gy) || 1; return { x: best.x + gx / gl * 2, y: best.y + gy / gl * 2, sp: 0.95 };
    }
    case 'cover': { const k = 0.35; return { x: lerp(home.x, b.x + (goalC.x - b.x) * k, 0.6), y: lerp(home.y, b.y * 0.5, 0.5), sp: 0.85 }; }
    case 'drop_back': return { x: clamp(home.x - d * 11, -HL + 2, HL - 2), y: home.y * 0.8, sp: 0.85 };
    case 'make_run': return { x: clamp(d * (Math.max(p.x * d, b.x * d) + 16), -HL + 2, HL - 4), y: home.y, sp: 1 };   // run down your own lane
    case 'support': {
      const c = owner && owner.team === p.team ? owner : b; const sgn = p.y > c.y ? 1 : -1;
      return { x: clamp(c.x - d * 3, -HL + 2, HL - 2), y: clamp(c.y + sgn * 11, -HW + 2, HW - 2), sp: 0.9 };
    }
    case 'stay_wide': {   // only wingers and full-backs hug the touchline; everyone else just keeps his own lane
      const wide = p.role === 'W' || p.role === 'FB';
      return { x: clamp(home.x + d * 8, -HL + 2, HL - 2), y: wide ? Math.sign(home.y || 1) * 28 : clamp(home.y * 1.15, -18, 18), sp: 0.9 };
    }
    case 'dribble': {
      let vx = oppGoal.x - p.x, vy = (oppGoal.y - p.y) * 0.6; const l = hyp(vx, vy) || 1; vx /= l; vy /= l;
      for (const o of teamOf(1 - p.team)) { const dx = p.x - o.x, dy = p.y - o.y, r = hyp(dx, dy); if (r < 7 && r > 0.1) { vx += dx / r / r * 6; vy += dy / r / r * 6; } }
      const l2 = hyp(vx, vy) || 1; return { x: clamp(p.x + vx / l2 * 10, -HL, HL), y: clamp(p.y + vy / l2 * 10, -HW, HW), sp: 0.85 };
    }
    case 'hold': return { x: p.x, y: p.y, sp: 0 };
    // goalkeeper positioning
    case 'stay_line': case 'sweep': case 'come_out': {
      const tx = b.x - goalC.x, ty = b.y - goalC.y, l = hyp(tx, ty) || 1;
      if (p.action === 'come_out') { const f = ballFuture(0.3); return { x: clamp(f.x, -HL, HL), y: clamp(f.y, -PEN_Y, PEN_Y), sp: 1 }; }
      const off = p.action === 'sweep' ? 13 : 4.2; return { x: goalC.x + tx / l * off, y: clamp(ty / l * off, -8, 8), sp: 0.9 };
    }
    default: return { ...home, sp: 0.6 };
  }
}

function movePlayer(p, tg, dt) {
  const dx = tg.x - p.x, dy = tg.y - p.y, dist = hyp(dx, dy);
  const vmax = p.pace * tg.sp * (p.stun > 0 ? 0.25 : 1) * (p.i === 0 ? 0.8 : 1);
  const want = dist > 0.25 ? Math.min(vmax, dist / 0.3) : 0;
  const tvx = dist > 0.01 ? dx / dist * want : 0, tvy = dist > 0.01 ? dy / dist * want : 0;
  p.vx += clamp(tvx - p.vx, -9 * dt, 9 * dt); p.vy += clamp(tvy - p.vy, -9 * dt, 9 * dt);
  p.x += p.vx * dt; p.y += p.vy * dt;
  if (hyp(p.vx, p.vy) > 0.6) p.face = Math.atan2(p.vy, p.vx);
  p.x = clamp(p.x, -HL - 2, HL + 2); p.y = clamp(p.y, -HW - 2, HW + 2);
}

// ---------------------------------------------------------------- rules: restarts, fouls, cards
function pushAway(team, x, y, r) {
  for (const p of teamOf(team)) { const dd = hyp(p.x - x, p.y - y); if (dd < r) { const k = r / (dd || 0.1); p.x = x + (p.x - x) * k; p.y = y + (p.y - y) * k; p.x = clamp(p.x, -HL, HL); p.y = clamp(p.y, -HW, HW); } }
}

function startRestart(kind, team, x, y, text, banner) {
  const b = M.ball;
  M.phase = 'restart'; M.timer = kind === 'penalty' ? 1.8 : kind === 'goalkick' ? 1.0 : 1.2; M.restart = { kind, team, x, y };
  b.vx = b.vy = b.vz = 0; b.z = 0; b.shot = false; b.flight = null; b.trail = [];
  let taker;
  if (kind === 'goalkick') taker = gkOf(team);
  else if (kind === 'penalty') taker = teamOf(team).filter((q) => q.i !== 0).sort((a, c) => c.shoot - a.shoot)[0];
  else taker = teamOf(team).filter((q) => q.i !== 0).sort((a, c) => hyp(a.x - x, a.y - y) - hyp(c.x - x, c.y - y))[0];
  for (const p of M.players) { p.pending = null; p.recv = null; if (p !== taker && p.action === 'receive') p.action = 'hold_shape'; }
  taker.x = x; taker.y = y; taker.vx = taker.vy = 0; b.x = x; b.y = y; b.owner = taker; b.lastTouch = taker; b.lastTeam = team; taker.action = 'hold'; taker.setPiece = true; M.freshRestart = kind;
  if (kind === 'throw' || kind === 'freekick' || kind === 'corner') pushAway(1 - team, x, y, 9.3);
  if (kind === 'goalkick') for (const p of teamOf(1 - team)) { const gx = Math.sign(x) * (HL - 5.5); if (Math.abs(p.x) > PEN_X - 1 && Math.abs(p.y) < PEN_Y + 1) p.x = Math.sign(x) * (PEN_X - 3); }
  if (kind === 'penalty') {
    const gx = Math.sign(x);
    const gk = gkOf(1 - team);
    for (const p of M.players) {
      if (p === taker || p === gk || p.red) continue;
      if (Math.abs(p.x) > PEN_X - 0.5 && Math.abs(p.y) < PEN_Y + 0.5 && p.x * gx > 0) p.x = gx * (PEN_X - 3 - rnd() * 3);
    }
    gk.x = gx * (HL - 0.4); gk.y = 0;
  }
  if (text) addComment(minute(), text);
  if (banner) flashText(banner[0], banner[1], 1.2);
}

function callFoul(def, att, x, y) {
  const st = M.stats[def.team]; st.fouls++; M.stop += 0.2;
  const inBox = Math.abs(x) > PEN_X && Math.abs(y) < PEN_Y && Math.sign(x) === dirOf(att.team);
  let card = '';
  const r = rnd();
  if (r < 0.018) { card = 'red'; } else if (r < 0.16) { card = 'yellow'; }
  let cardText = '';
  if (card === 'yellow') { def.yellow++; st.yellow++; if (def.yellow >= 2) { card = 'red'; cardText = ' Second yellow, he is sent off!'; st.yellow--; } else cardText = ' Yellow card.'; }
  if (card === 'red') { def.red = true; st.red++; if (!cardText) cardText = ' Straight red card!'; }
  M.stop += card === 'red' ? 0.7 : card === 'yellow' ? 0.3 : 0;
  if (inBox) startRestart('penalty', att.team, dirOf(att.team) * (HL - 11), 0, `<b>PENALTY!</b> ${TEAMS[def.team].short} #${def.num} fouls #${att.num} in the box.${cardText}`, ['PENALTY!', 'whistle']);
  else startRestart('freekick', att.team, clamp(x, -HL + 1, HL - 1), clamp(y, -HW + 1, HW - 1), `Foul by ${TEAMS[def.team].short} #${def.num} on #${att.num}.${cardText}`, [card === 'red' ? 'RED CARD' : card === 'yellow' ? 'YELLOW CARD' : 'FOUL', card === 'red' ? 'card-r' : card === 'yellow' ? 'card-y' : 'whistle']);
  if (def.red) { def.x = 0; def.y = HW + 6; }
}

function goalScored(team) {
  M.score[team]++; M.stop += 0.6;
  const b = M.ball; const sc = b.lastTouch;
  if (b.shot && !b.saveTried) M.stats[team].onTarget++;
  const og = sc && sc.team !== team;
  addComment(minute(), `<span class="hlg"><b>GOAL!</b> ${TEAMS[team].name} — ${og ? `own goal by ${TEAMS[sc.team].short} #${sc.num} ${sc.label}` : sc ? `#${sc.num} ${sc.label} finds the net` : 'finds the net'}. ${M.score[0]}–${M.score[1]}</span>`);
  flashText('GOAL!', 'goal', 2.4);
  M.phase = 'goal'; M.timer = 3.2; M.concede = 1 - team; b.owner = null; b.vx = b.vy = 0; b.shot = false; b.flight = null;
  renderStats();
}

function ballOut() {
  const b = M.ball;
  if (Math.abs(b.y) > HW) {
    const team = 1 - b.lastTeam;
    return startRestart('throw', team, clamp(b.x, -HL + 1, HL - 1), Math.sign(b.y) * (HW - 0.4), `Throw-in to ${TEAMS[team].short}.`, null);
  }
  const end = Math.sign(b.x); const att = M.dir[0] === end ? 0 : 1, def = 1 - att;
  if (Math.abs(b.y) < GOAL && b.z < 2.44) return goalScored(att);
  if (b.lastTeam === def) { M.stats[att].corners++; return startRestart('corner', att, end * (HL - 0.4), Math.sign(b.y || 1) * (HW - 0.4), `Corner to ${TEAMS[att].short}.`, ['CORNER', 'whistle']); }
  return startRestart('goalkick', def, end * (HL - 5.5), 0, `Goal kick to ${TEAMS[def].short}.`, null);
}

function takeControl(p) {
  const b = M.ball;
  const fl = b.flight || (b.lastFlight && M.t - b.lastFlight.t0 < 4 ? b.lastFlight : null);
  b.lastFlight = null;
  if (fl && fl.team === p.team && fl.passer !== p && fl.offside.has(p.id)) {
    M.stats[p.team].offsides++;
    return startRestart('freekick', 1 - p.team, clamp(p.x, -HL + 1, HL - 1), clamp(p.y, -HW + 1, HW - 1), `<b>Offside!</b> #${p.num} (${TEAMS[p.team].short}) was beyond the last defender.`, ['OFFSIDE', 'whistle']);
  }
  if (fl && fl.team === p.team && fl.passer !== p) M.stats[p.team].passOk++;
  if (b.shot && p.i !== 0 && p.team !== b.shotTeam) addComment(minute(), `Blocked by ${TEAMS[p.team].short} #${p.num}!`);
  b.owner = p; b.lastTouch = p; b.lastTeam = p.team; b.flight = null; b.shot = false; b.lofted = false; p.recv = null; p.pending = null; p.holdT = 0;
  p.action = p.i === 0 ? 'hold' : 'dribble';
  for (const q of M.players) if (q.action === 'receive' && q !== p) q.action = 'hold_shape';
}

function save(gk) {
  const b = M.ball; const speed = hyp(b.vx, b.vy); const d = hyp(gk.x - b.x, gk.y - b.y);
  b.saveTried = true;
  const pr = clamp(0.8 - 0.25 * (d / 2) + 0.28 * (gk.gk - 0.5) - 0.012 * (speed - 20), 0.12, 0.95);
  if (b.shotTeam != null) M.stats[b.shotTeam].onTarget++;
  if (rnd() < pr) {
    if (rnd() < 0.5) { takeControl(gk); addComment(minute(), `Saved and held by ${TEAMS[gk.team].short} #${gk.num}.`); flashText('SAVE!', 'whistle', 0.8); }
    else {
      const side = rnd() < 0.5 ? -1 : 1; b.vx = -dirOf(1 - gk.team) * rr(2, 6); b.vy = side * rr(5, 10); b.vz = rr(1, 4); b.shot = false; b.lastTouch = gk; b.lastTeam = gk.team; b.flight = null; gk.ctrlCd = 0.4;
      addComment(minute(), `Parried away by ${TEAMS[gk.team].short} #${gk.num}!`); flashText('SAVE!', 'whistle', 0.8);
    }
  }
}

// ---------------------------------------------------------------- simulation step
function step(dt) {
  if (!M) return;
  if (flash) { flash.t -= dt; if (flash.t <= 0) { flash = null; $('#banner').className = 'banner'; } }
  const b = M.ball;
  if (M.phase === 'goal') {
    M.timer -= dt; for (const p of M.players) movePlayer(p, { x: p.x, y: p.y, sp: 0 }, dt);
    if (M.timer <= 0) kickoff(M.concede, false);
    return;
  }
  if (M.phase === 'half' || M.phase === 'over' || M.phase === 'shootout') return;
  if (M.phase === 'restart') {
    M.timer -= dt;
    for (const p of M.players) { if (b.owner === p || p.red) continue; movePlayer(p, { ...homeOf(p), sp: 0.7 }, dt); }
    if (b.owner) { b.x = b.owner.x; b.y = b.owner.y; }
    if (M.timer <= 0) {
      if (M.restart && M.restart.kind === 'penalty') return takePenalty();
      M.phase = 'play';
    }
    return;
  }

  // ---- live play
  M.t += dt;
  if (b.owner) M.stats[b.owner.team].poss += dt;
  for (let t = 0; t < 2; t++) { M.tickT[t] -= dt; if (M.tickT[t] <= 0 && !M.inflight[t]) { M.tickT[t] = 0.35; tickTeam(t); } }

  if (b.owner && b.owner.pending) { const o = b.owner, a = o.pending; o.pending = null; execute(o, a); }
  if (b.owner && b.owner.i === 0) { b.owner.holdT += dt; if (b.owner.holdT > 3 && !b.owner.pending) { b.owner.holdT = 0; doPass(b.owner, 'gk'); } }

  M.markT = (M.markT || 0) - dt; if (M.markT <= 0) { M.markT = 0.5; assignMarks(); }
  updateRanks();
  ensureChasers();
  for (const p of M.players) {
    if (p.red) continue;
    p.tackleCd = Math.max(0, p.tackleCd - dt); p.ctrlCd = Math.max(0, p.ctrlCd - dt); p.stun = Math.max(0, p.stun - dt);
    const tg = targetFor(p);
    if (b.owner !== p && p.action !== 'receive' && !p.chaser && !((p.action === 'press') && p.brank <= 1)) {   // stay inside your zone
      const h = homeOf(p), lim = LEASH[p.role] || 20, dx = tg.x - h.x, dy = tg.y - h.y, dd = hyp(dx, dy);
      if (dd > lim) { tg.x = h.x + dx / dd * lim; tg.y = h.y + dy / dd * lim; }
    }
    movePlayer(p, tg, dt);
  }
  // separation
  const ps = M.players.filter((p) => !p.red);
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    const a = ps[i], c = ps[j]; const dx = c.x - a.x, dy = c.y - a.y, d = hyp(dx, dy);
    if (d < 0.9 && d > 0.001) { const k = (0.9 - d) / 2 / d; a.x -= dx * k; a.y -= dy * k; c.x += dx * k; c.y += dy * k; }
  }

  // ---- ball
  if (b.owner) {
    const o = b.owner; const fx = Math.cos(o.face), fy = Math.sin(o.face);
    b.x = lerp(b.x, o.x + fx * 0.75, 0.5); b.y = lerp(b.y, o.y + fy * 0.75, 0.5); b.z = 0; b.vx = o.vx; b.vy = o.vy; b.vz = 0;
    // tackles
    for (const q of teamOf(1 - o.team)) {
      if (q.tackleCd > 0 || (q.action !== 'press' && q.action !== 'mark')) continue;
      if (hyp(q.x - o.x, q.y - o.y) > 1.5) continue;
      q.tackleCd = 0.8;
      const win = clamp(0.3 + 0.4 * (q.tackle - o.drib) - (o.action === 'hold' ? 0.05 : 0), 0.1, 0.65);
      const success = rnd() < win;
      if (rnd() < (success ? 0.04 : 0.14)) return callFoul(q, o, o.x, o.y);
      if (success) {
        b.owner = null; b.lastTouch = q; b.lastTeam = q.team; b.flight = null;
        const a = Math.atan2(q.y - o.y, q.x - o.x) + gauss() * 0.4; b.vx = Math.cos(a) * 5; b.vy = Math.sin(a) * 5; b.vz = 0;
        o.stun = 0.6; o.ctrlCd = 0.5; o.pending = null; o.action = 'hold_shape'; addComment(minute(), `${TEAMS[q.team].short} #${q.num} wins the ball off #${o.num}.`);
        break;
      } else { q.stun = 0.5; }
    }
  } else {
    // flight physics
    if (b.z > 0 || b.vz > 0) {
      b.vz -= G * dt; b.z += b.vz * dt;
      if (b.z <= 0) { b.z = 0; const k = b.shot ? 0.9 : b.lofted ? 0.2 : 0.5; if (b.vz < -1.5 && !b.lofted) b.vz = -b.vz * 0.4; else b.vz = 0; b.vx *= k; b.vy *= k; }   // a lofted ball loses most of its pace when it lands
    } else { const sp = hyp(b.vx, b.vy); if (sp > 0) { const ns = Math.max(0, sp - (ROLL + (b.lofted ? 0.4 * sp : 0)) * dt); b.vx *= ns / sp; b.vy *= ns / sp; } }
    b.x += b.vx * dt; b.y += b.vy * dt;
    if (b.flight && b.z === 0 && hyp(b.vx, b.vy) < 4.5) { b.lastFlight = b.flight; b.flight = null; }   // a slow ball is simply loose: anyone can claim it
    b.trail.push([b.x, b.y, b.z]); if (b.trail.length > 18) b.trail.shift();

    // goalkeeper save on shots
    if (b.shot && !b.saveTried) { const gk = gkOf(1 - b.shotTeam); if (!gk.red && hyp(gk.x - b.x, gk.y - b.y) < 2.2 && b.z < 2.6) { save(gk); if (!b.owner && !b.shot) { /* parried */ } } }
    // control / interceptions
    if (!b.owner) {
      const speed = hyp(b.vx, b.vy);
      const fl0 = b.flight || b.lastFlight; const tg0 = fl0 && fl0.target;
      const rank = (p) => hyp(p.x - b.x, p.y - b.y) - (p === tg0 ? 1.6 : 0);   // the intended receiver gets first touch when it is close
      for (const p of [...M.players].sort((a, c) => rank(a) - rank(c))) {
        if (p.red || p.ctrlCd > 0) continue;
        const dd = hyp(p.x - b.x, p.y - b.y), reach = p.i === 0 ? 1.8 : 1.45;
        if (dd > reach || b.z > (p.i === 0 ? 2.6 : 1.9)) continue;
        p.ctrlCd = 0.12;
        const mine = b.flight && b.flight.team === p.team;
        if (b.flight && !mine) { if (b.flight.tried && b.flight.tried.has(p.id)) continue; (b.flight.tried = b.flight.tried || new Set()).add(p.id); }
        let pr;
        if (mine && b.flight.target === p) pr = 0.72 + 0.3 * p.pass - speed * 0.01;
        else if (mine) pr = 0.5 + 0.35 * p.pass - speed * 0.01;
        else if (b.flight) pr = 0.08 + 0.34 * p.tackle - speed * 0.008;
        else pr = 0.6 + 0.35 * p.pass - speed * 0.012;
        if (b.shot) pr *= 0.55;
        if (p.i === 0) pr += 0.15;
        if (rnd() < clamp(pr, 0.06, 0.97)) { takeControl(p); break; }
        if (!b.shot) { b.vx *= 0.6; b.vy *= 0.6; }   // a heavy touch: the ball loses pace instead of running through
      }
    }
    // out of play / goal
    if (!b.owner && (Math.abs(b.y) > HW || Math.abs(b.x) > HL)) return ballOut();
  }
  if (b.owner && (Math.abs(b.y) > HW || Math.abs(b.x) > HL)) { b.lastTeam = b.owner.team; return ballOut(); }

  // end of half
  { const i = periodInfo(); if (M.t >= i.per + addedMin() * i.per / i.len) endHalf(); }
}

function takePenalty() {
  const r = M.restart, taker = M.ball.owner, team = r.team, gk = gkOf(1 - team);
  M.phase = 'play'; const d = dirOf(team);
  const scored = rnd() < 0.76 + 0.1 * (taker.shoot - 0.6);
  const side = rnd() < 0.5 ? -1 : 1;
  const b = M.ball; b.owner = null; b.lastTouch = taker; b.lastTeam = team; b.shot = true; b.shotTeam = team; M.stats[team].shots++;
  const aimY = scored ? side * rr(2, 3.3) : (rnd() < 0.5 ? side * rr(3.9, 5) : side * rr(0.3, 1.2));
  const a = Math.atan2(aimY - taker.y, d * HL - taker.x), sp = 26;
  b.x = taker.x + Math.cos(a) * 0.8; b.y = taker.y + Math.sin(a) * 0.8; b.z = 0.2; b.vx = Math.cos(a) * sp; b.vy = Math.sin(a) * sp; b.vz = 0.4;
  gk.y = (scored ? -side : (Math.abs(aimY) < 1.4 ? 0 : side)) * 1.8; b.saveTried = !scored && Math.abs(aimY) < 1.4 ? false : true;
  M.stats[team].onTarget += scored || Math.abs(aimY) < 3.6 ? 1 : 0;
  taker.ctrlCd = 0.8;
}

function finishMatch(title, sub) {
  M.phase = 'over';
  const stat = (i) => { const s = M.tel[i]; return `<div><div class="muted">${TEAMS[i].name} · ${providerName(M.providers[i])}</div><b>${s.calls ? Math.round(s.ms / s.calls) : 0} ms</b> <span class="muted">avg per decision · ${s.calls} calls${s.fallbacks ? ` · ${s.fallbacks} fell back` : ''}</span></div>`; };
  showOverlay(`<div class="box"><h3>${title}</h3><p>${sub}</p><div class="cmp">${stat(0)}${stat(1)}</div>${statsTable()}<button class="btn primary" id="againBtn" style="width:auto;padding:11px 26px">New match</button></div>`);
  $('#againBtn').onclick = () => { $('#overlay').hidden = true; $('#setupCard').hidden = false; M.phase = 'setup'; };
}

function breakTo(nextHalf, title, dirs, kickTeam, msg, label) {
  M.phase = 'half'; flashText(title.toUpperCase(), 'whistle', 2.5);
  addComment(label, `<b>${title}.</b> ${TEAMS[0].name} ${M.score[0]}–${M.score[1]} ${TEAMS[1].name}.`);
  showOverlay(`<div class="box"><h3>${title}</h3><p>${TEAMS[0].name} ${M.score[0]} – ${M.score[1]} ${TEAMS[1].name}</p>${statsTable()}</div>`);
  setTimeout(() => {
    if (!M || M.phase !== 'half') return;
    $('#overlay').hidden = true; M.half = nextHalf; M.t = 0; M.stop = 0; M.dir = dirs; kickoff(kickTeam, false); addComment(label, msg);
  }, 3500 / Math.max(1, speed));
}

function endHalf() {
  const level = M.score[0] === M.score[1];
  const scoreLine = `${TEAMS[0].name} ${M.score[0]} – ${M.score[1]} ${TEAMS[1].name}`;
  if (M.half === 1) return breakTo(2, 'Half time', [-1, 1], 1, 'Second half under way.', 45);
  if (M.half === 2) {
    if (level && M.knockout) return breakTo(3, 'Full time: level, extra time', [1, -1], 0, 'Extra time begins.', 90);
    addComment(90, `<b>Full time.</b> ${scoreLine}.`);
    return finishMatch(level ? 'Draw' : `${TEAMS[M.score[0] > M.score[1] ? 0 : 1].name} win`, scoreLine);
  }
  if (M.half === 3) return breakTo(4, 'Extra time: half time', [-1, 1], 1, 'Second half of extra time.', 105);
  if (!level) {
    addComment(120, `<b>Full time after extra time.</b> ${scoreLine}.`);
    return finishMatch(`${TEAMS[M.score[0] > M.score[1] ? 0 : 1].name} win after extra time`, scoreLine);
  }
  shootout();
}

function shootout() {
  M.phase = 'shootout'; flashText('PENALTIES', 'whistle', 2);
  addComment(120, 'Still level after extra time: <b>penalty shoot-out</b>.');
  const order = [0, 1].map((t) => teamOf(t).filter((p) => p.i !== 0).sort((a, c) => c.shoot - a.shoot));
  const kicks = [[], []], taken = []; let winner = 0;
  const remaining = (t) => Math.max(0, 5 - kicks[t].length);
  outer: for (let r = 0; r < 60; r++) for (const t of [0, 1]) {
    const taker = order[t][r % order[t].length];
    const pr = clamp(0.76 + 0.1 * (taker.shoot - 0.6) - 0.1 * (gkOf(1 - t).gk - 0.7), 0.5, 0.92);
    const ok = rnd() < pr; kicks[t].push(ok); taken.push({ t, taker, ok });
    const sc = [kicks[0].filter(Boolean).length, kicks[1].filter(Boolean).length];
    if (r < 5) { if (sc[0] > sc[1] + remaining(1)) { winner = 0; break outer; } if (sc[1] > sc[0] + remaining(0)) { winner = 1; break outer; } }
    else if (t === 1 && sc[0] !== sc[1]) { winner = sc[0] > sc[1] ? 0 : 1; break outer; }
  }
  const shown = [[], []]; let i = 0;
  const row = (t) => `<div style="margin:6px 0"><b style="color:${TEAMS[t].color}">${TEAMS[t].name}</b> &nbsp; ${shown[t].map((o) => (o ? '<span style="color:#4ade80">&#9679;</span>' : '<span style="color:#f87171">&#10005;</span>')).join(' ')} &nbsp; <b>${shown[t].filter(Boolean).length}</b></div>`;
  const render = () => showOverlay(`<div class="box"><h3>Penalty shoot-out</h3><p>${M.score[0]}–${M.score[1]} after extra time</p>${row(0)}${row(1)}</div>`);
  render();
  const tick = () => {
    if (!M || M.phase !== 'shootout') return;
    if (i < taken.length) {
      const k = taken[i++]; shown[k.t].push(k.ok);
      addComment(120, `${TEAMS[k.t].short} #${k.taker.num} ${k.ok ? '<b>scores</b>' : 'misses'}.`);
      render(); setTimeout(tick, 900 / Math.max(1, speed));
    } else {
      M.pens = [shown[0].filter(Boolean).length, shown[1].filter(Boolean).length];
      finishMatch(`${TEAMS[winner].name} win on penalties`, `${M.score[0]}–${M.score[1]} (${M.pens[0]}–${M.pens[1]} on penalties)`);
    }
  };
  setTimeout(tick, 1400);
}

// ---------------------------------------------------------------- drawing
function draw() {
  ctx.clearRect(0, 0, CW, CH);
  ctx.fillStyle = '#0a1a10'; ctx.fillRect(0, 0, CW, CH);
  // grass with mowing stripes
  const x0 = sx(-HL), y0 = sy(-HW), w = 2 * HL * SC, h = 2 * HW * SC;
  const g = ctx.createLinearGradient(0, y0, 0, y0 + h); g.addColorStop(0, '#2e7d46'); g.addColorStop(1, '#27703d'); ctx.fillStyle = g; ctx.fillRect(x0, y0, w, h);
  for (let i = 0; i < 14; i++) { if (i % 2) { ctx.fillStyle = 'rgba(255,255,255,.035)'; ctx.fillRect(x0 + (w / 14) * i, y0, w / 14, h); } }
  ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.6;
  ctx.strokeRect(x0, y0, w, h);
  ctx.beginPath(); ctx.moveTo(sx(0), y0); ctx.lineTo(sx(0), y0 + h); ctx.stroke();
  ctx.beginPath(); ctx.arc(sx(0), sy(0), 9.15 * SC, 0, 7); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(sx(0), sy(0), 2, 0, 7); ctx.fill();
  for (const s of [-1, 1]) {
    ctx.strokeRect(s < 0 ? x0 : sx(HL - 16.5), sy(-PEN_Y), 16.5 * SC, 2 * PEN_Y * SC);
    ctx.strokeRect(s < 0 ? x0 : sx(HL - 5.5), sy(-9.16), 5.5 * SC, 18.32 * SC);
    ctx.beginPath(); ctx.arc(sx(s * (HL - 11)), sy(0), 2, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(sx(s * (HL - 11)), sy(0), 9.15 * SC, s < 0 ? -0.93 : Math.PI - 0.93, s < 0 ? 0.93 : Math.PI + 0.93); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fillRect(s < 0 ? x0 - 2.4 * SC : sx(HL), sy(-GOAL), 2.4 * SC, 2 * GOAL * SC);
    ctx.strokeRect(s < 0 ? x0 - 2.4 * SC : sx(HL), sy(-GOAL), 2.4 * SC, 2 * GOAL * SC);
  }
  if (!M || M.phase === 'setup') { ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.font = '600 16px system-ui'; ctx.textAlign = 'center'; ctx.fillText('Pick the models and kick off', CW / 2, CH / 2 + 5); return; }

  const b = M.ball;
  // decision lines
  if (M.phase === 'play') for (const p of M.players) {
    if (p.red || !['press', 'make_run', 'mark', 'support', 'receive'].includes(p.action)) continue;
    const tg = targetFor(p); ctx.strokeStyle = p.action === 'press' ? 'rgba(251,113,133,.55)' : p.action === 'make_run' ? 'rgba(74,222,128,.55)' : 'rgba(147,197,253,.4)';
    ctx.lineWidth = 1.2; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(sx(p.x), sy(p.y)); ctx.lineTo(sx(tg.x), sy(tg.y)); ctx.stroke(); ctx.setLineDash([]);
  }
  // players
  for (const p of M.players) {
    if (p.red) continue;
    const T = TEAMS[p.team]; const col = p.i === 0 ? T.gk : T.color; const r = 0.95 * SC + 2;
    if (b.owner === p) { ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), r + 4, 0, 7); ctx.stroke(); }
    ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.beginPath(); ctx.ellipse(sx(p.x) + 1, sy(p.y) + 2, r, r * 0.6, 0, 0, 7); ctx.fill();
    ctx.fillStyle = col; ctx.strokeStyle = T.light; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), r, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#04122b'; ctx.font = `700 ${Math.max(8, r)}px system-ui`; ctx.textAlign = 'center'; ctx.fillText(p.num, sx(p.x), sy(p.y) + r * 0.36);
    ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.font = '600 8px system-ui'; ctx.fillText(p.label, sx(p.x), sy(p.y) + r + 9);
    if (p.yellow) { ctx.fillStyle = '#facc15'; ctx.fillRect(sx(p.x) + r * 0.6, sy(p.y) - r * 1.6, 4, 6); }
    if (b.owner === p && p.prob) { // decision chip over the ball carrier
      const txt = `${p.action.replace('_', ' ')} ${Math.round(p.prob * 100)}%`; ctx.font = '600 11px system-ui'; const tw = ctx.measureText(txt).width + 10;
      ctx.fillStyle = 'rgba(7,16,12,.85)'; ctx.fillRect(sx(p.x) - tw / 2, sy(p.y) - r - 24, tw, 16); ctx.fillStyle = '#e8f1ec'; ctx.fillText(txt, sx(p.x), sy(p.y) - r - 12);
    }
  }
  // ball
  for (let i = 1; i < b.trail.length; i++) { const p0 = b.trail[i - 1], p1 = b.trail[i]; ctx.strokeStyle = `rgba(255,255,255,${i / b.trail.length * 0.45})`; ctx.lineWidth = 1 + i / b.trail.length * 1.5; ctx.beginPath(); ctx.moveTo(sx(p0[0]), sy(p0[1]) - p0[2] * SC * 0.5); ctx.lineTo(sx(p1[0]), sy(p1[1]) - p1[2] * SC * 0.5); ctx.stroke(); }
  const lift = b.z * SC * 0.5;
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(sx(b.x), sy(b.y), 4 + b.z * 0.4, 2.4, 0, 0, 7); ctx.fill();
  ctx.shadowColor = 'rgba(255,255,255,.9)'; ctx.shadowBlur = 8; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(sx(b.x), sy(b.y) - lift, 4 + Math.min(b.z, 6) * 0.2, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
  // scoreboard
  const m = minute();
  $('#hudScore').innerHTML = `<span class="t" style="color:${TEAMS[0].color}">${TEAMS[0].short}</span><span class="s">${M.score[0]}</span><span class="s" style="color:var(--muted)">–</span><span class="s">${M.score[1]}</span><span class="t" style="color:${TEAMS[1].color}">${TEAMS[1].short}</span><span class="clock">${clockText()}</span><span class="clock">${teamOf(0).length} v ${teamOf(1).length}</span>${M.pens ? `<span class="clock">(${M.pens[0]}–${M.pens[1]} pens)</span>` : ''}`;
}

function flashText(text, cls, sec) { const el = $('#banner'); el.textContent = text; el.className = `banner show ${cls || ''}`; flash = { t: sec }; }
function showOverlay(html) { const o = $('#overlay'); o.innerHTML = html; o.hidden = false; }

// ---------------------------------------------------------------- UI
function addComment(min, html) {
  const el = $('#commentary'); const d = document.createElement('div'); d.className = 'line';
  d.innerHTML = `<span class="ov">${min ? min + "'" : ''}</span><span>${html}</span>`; el.prepend(d);
  while (el.children.length > 80) el.lastChild.remove();
}
const srcBadge = (res) => { const fb = res.fallbackFrom && res.fallbackFrom !== 'local'; return `<span class="badge ${fb ? 'warn' : res.source}">${fb ? 'fallback·local' : res.source}</span> ${res.latencyMs ?? 0} ms`; };
function bars(probs, picked, max = 5) {
  return `<div class="bars">${Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, max).map(([k, p]) => `<div class="bar ${k === picked ? 'pick' : ''}"><span>${k.replace('_', ' ')}</span><div class="track"><div class="fill" style="width:${Math.round(p * 100)}%"></div></div><span class="pct">${Math.round(p * 100)}%</span></div>`).join('')}</div>`;
}
function renderTeamDecisions(t) {
  const L = M.last[t]; if (!L) return;
  const box = $(t === 0 ? '#decA' : '#decB'); box.className = 'dec';
  const car = L.picks.find((x) => x.ctx === 'carrier' || x.ctx === 'gk_ball');
  let html = '';
  if (car) html += `<div class="carrierbox"><div class="qh"><span>${TEAMS[t].short} #${car.p.num} ${car.p.label} has the ball${car.ans.model && car.ans.model !== car.action ? ` <span class="muted">(model said ${car.ans.model})</span>` : ''}</span><b>${car.action.replace('_', ' ')}</b></div>${bars(car.ans.probs, car.action)}</div>`;
  html += `<div class="plist">${L.picks.map((x) => `<div class="prow ${car && x === car ? 'ball' : ''}"><span>#${x.p.num} ${x.p.label}</span><span class="a a-${x.action}">${x.action.replace('_', ' ')} ${Math.round(x.prob * 100)}%</span></div>`).join('')}</div>`;
  box.innerHTML = html; $(t === 0 ? '#srcA' : '#srcB').innerHTML = srcBadge(L.res);
}

function statsTable() {
  const a = M.stats[0], b = M.stats[1], tot = (a.poss + b.poss) || 1;
  const pa = Math.round(a.poss / tot * 100), pb = 100 - pa;
  const row = (k, x, y) => `<div class="mstat"><span class="a">${x}</span><span class="k">${k}</span><span class="b">${y}</span></div>`;
  return `<div class="possbar"><i style="width:${pa}%;background:${TEAMS[0].color}"></i><i style="width:${pb}%;background:${TEAMS[1].color}"></i></div>`
    + row('Possession', pa + '%', pb + '%') + row('Shots (on target)', `${a.shots} (${a.onTarget})`, `${b.shots} (${b.onTarget})`)
    + row('Passes completed', `${a.passOk}/${a.passes}`, `${b.passOk}/${b.passes}`) + row('Fouls', a.fouls, b.fouls) + row('Yellow / red', `${a.yellow} / ${a.red}`, `${b.yellow} / ${b.red}`)
    + row('Offsides', a.offsides, b.offsides) + row('Corners', a.corners, b.corners);
}
let statTimer = 0;
function renderLineups() {
  $('#lineups').innerHTML = [0, 1].map((t) => {
    const ps = M.players.slice(t * 11, t * 11 + 11); const on = ps.filter((p) => !p.red).length;
    const dots = ps.map((p) => `<i class="pd ${p.red ? 'off' : ''} ${p.yellow && !p.red ? 'yel' : ''}" style="background:${p.red ? 'transparent' : p.i === 0 ? TEAMS[t].gk : TEAMS[t].color};border-color:${TEAMS[t].color}" title="#${p.num} ${p.label}${p.red ? ' (sent off)' : p.yellow ? ' (yellow card)' : ''}"></i>`).join('');
    const line = (a, b) => ps.slice(a, b).map((p) => `<span class="${p.red ? 'gone' : ''}">${p.num} ${p.label}</span>`).join(' · ');
    return `<div class="lineup"><div class="lt"><b>${TEAMS[t].name}</b><span>${on} players · 4-4-2</span></div><div class="dots">${dots}</div>
      <div class="roles"><div><i>GK</i>${line(0, 1)}</div><div><i>DEF</i>${line(1, 5)}</div><div><i>MID</i>${line(5, 9)}</div><div><i>ATT</i>${line(9, 11)}</div></div></div>`;
  }).join('') + '<p class="hint" style="margin:8px 0 0">11 per side: 10 outfield players and a goalkeeper. Sent-off players are not replaced.</p>';
}
function renderStats() {
  if (!M) return;
  renderLineups();
  $('#matchStats').innerHTML = statsTable();
  $('#stats').innerHTML = [0, 1].map((i) => { const s = M.tel[i], p = M.providers[i];
    return `<div class="stat"><div class="t"><span>${TEAMS[i].name}</span><span class="badge ${p}">${providerName(p)}</span></div><div class="m"><div><b>${s.calls ? Math.round(s.ms / s.calls) : 0}</b>avg ms</div><div><b>${s.calls}</b>ticks</div><div><b>${s.fallbacks}</b>fallbacks</div></div>${s.lastErr ? `<div class="muted" style="font-size:11px;margin-top:6px;word-break:break-word">${String(s.lastErr).slice(0, 120)}</div>` : ''}</div>`; }).join('');
}

function frame(ts) {
  const dtReal = Math.min(0.1, (ts - lastTs) / 1000 || 0); lastTs = ts;
  if (!paused && M && M.phase !== 'setup' && M.phase !== 'over') {
    acc += dtReal * speed; let n = 0;
    while (acc >= DT && n++ < 60) { step(DT); acc -= DT; }
    statTimer += dtReal; if (statTimer > 1) { statTimer = 0; renderStats(); }
  }
  draw(); requestAnimationFrame(frame);
}

async function init() {
  const wrap = document.querySelector('.pitch-wrap'); const hud = document.createElement('div'); hud.id = 'hudScore'; hud.className = 'hud-score'; wrap.appendChild(hud);
  sizeCanvas();
  try { providersStatus = await (await fetch('/api/status')).json(); } catch { /* local only */ }
  $('#startBtn').onclick = newMatch;
  requestAnimationFrame(frame);
}
init();
