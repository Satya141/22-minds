# 22 Minds

A football match where all 22 players think for themselves. Every ~350 ms each player asks a small decision model what to do next (pass, shoot, press, mark, make a run...), one batched request per team per tick. A side project built with Claude Code.

The engine owns the physics and the laws of the game. The model only picks *what* a player does, and its raw answer is used as is (no blending with a hand-written prior). Laya is a general-purpose model, so expect rougher play than the built-in heuristic model.

## Run

Requires Node 18+. No npm dependencies.

```bash
npm start        # the game on http://localhost:3000
```

Without a model server running, the game uses the built-in heuristic model (no key, no network).

### Use Laya (open source, runs locally)

[Laya](https://github.com/NandhaKishorM/laya) is an open-weights (Apache-2.0) decision model that answers typed multiple-choice questions in one forward pass.

```bash
python -m venv .venv
.venv/Scripts/pip install "laya[serve]"     # Windows; use .venv/bin/pip on macOS/Linux
# optional, much faster on an NVIDIA GPU:
#   .venv/Scripts/pip install torch --index-url https://download.pytorch.org/whl/cu128
npm run laya     # serves the Jev-compatible API on 127.0.0.1:8000
npm start
```

On an RTX 5050 it answers one question in about 40 ms and 11 questions in about 230 ms. On CPU it is roughly 10x slower, which is too slow for live play.

Alternatively use it through the Vercel AI Gateway: copy `.env.example` to `.env` and set `AI_GATEWAY_API_KEY`. The key stays on the server and is never sent to the browser. Laya on the gateway was free through 2026-10-31; Jev (`typesafe-ai/jev`) needs paid gateway credits.

## Rules implemented

Kick-off, goals, throw-ins, goal kicks, corners, offside (with the throw-in / goal-kick / corner exemption), fouls, free kicks, penalties, yellow and red cards (two yellows = red), stoppage time, half time with a change of ends, and full time. Knockout mode adds extra time and a penalty shoot-out.

Not implemented: substitutions, VAR, advantage, handball, injuries and the back-pass rule.

## Files

- `server.js`: static server and `/api/decide` proxy to Laya / Jev / built-in
- `local-model.js`, `local-football.js`: the built-in decision model
- `public/football.js`, `public/index.html`: the game

## License

MIT
