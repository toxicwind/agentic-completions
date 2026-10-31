# agentic-completions

Freeinference/Qwen agentic-completion harness + MCP auto workflow. Born from a
live session where the vision-kit MCP returned empty strings and 400s on its
model lane — this product replaces flaky model-backed MCP judgment with a
deterministic client that **runs code first and only then consults the model**.

## Doctrine
1. **Code proves; the model advises.** `satisfy()` runs all code checks first;
   a passing code gate is satisfaction. The model can flag concerns (advisory)
   but can never flip what code proved — including when its verdict is malformed.
2. **Declared ≠ observed.** `/v1/models` lists 2 models; `qwen3.6-35b` actually
   accepts image input (verified live). Probe lanes, don't read cards.
3. **Cloudflare UA wall** — always send a desktop browser UA (anomaly #14).
4. **max_tokens ≥ 2500** when reasoning may engage (anomaly #1; qwen3.6 spends
   ~500 completion tokens reasoning on one-sentence asks).
5. **Gateway MCP primary, eval/Qwen fallback** — `mcp_auto.auto()` retries,
   validates output, and only falls back to a clearly-labeled `qwen-fallback`
   lane for READ-ONLY judgment. Mutating ops must not pass `fallback_prompt`.

## Usage (bun first-class)

```bash
bun install && bun test   # 19 tests green
```

```typescript
import { chat, structured, satisfy } from "./ts/src/completions.ts";
import { auto } from "./ts/src/mcp-auto.ts";
import { runLoop } from "./ts/src/loop.ts";

const { text, usage } = await chat([{ role: "user", content: "..." }]);        // UA-wall, 429 retry
const { data } = await structured<MyShape>(msgs);                              // strict JSON + repair round
const res = await satisfy([{ name: "tests green", run: () => [ok, ev] }], "p"); // code-first gate
const r = await auto("server:tool", args, { validate: Boolean });              // gateway -> qwen fallback
const o = await runLoop({ goal, workdir }, { provider });                      // agentic loop; finish gated on exec
```

MCP stdio server: `bun run start` exposes `agentic_complete(goal, workdir)` (plus `apply_patch` inside the loop — offline patchling-apply --dumb lane).

Python reference lane (v1.0): `_archive/py/` — archived, not the runtime.

Keys: `FREEINFERENCE_API_KEY` env or secretsmith keyring.

## TS lane (`ts/`) — tool-calling agentic loop + MCP stdio server

Bun/TS implementation of the same doctrine as a server-side agentic loop:

- `ts/src/loop.ts` — model drives `exec_code` / `read_file` / `write_file`;
  the `finish(verified=true)` tool is **REJECTED** until ≥1 successful
  `exec_code` run (code-run-first enforced at the tool boundary, not just
  before consult). Path traversal blocked; workdir-sandboxed.
- `ts/src/provider.ts` — freeinference/Qwen client: browser UA (anomaly #14),
  429/5xx retry+backoff honoring `retry-after` (max 3 attempts),
  `max_tokens ≥ 2500` floor (anomaly #1), monadic `Result` returns.
- `ts/bin/cli.ts` — MCP stdio server exposing `agentic_complete(goal, workdir)`
  (env: `FREEINFERENCE_API_KEY`, `AGENTIC_MODEL`, `AGENTIC_MAX_STEPS`).

```bash
cd ts && bun install && bun test   # 8 tests green
echo '{"jsonrpc":"2.0","id":1,"method":"initialize",...}' | \
  FREEINFERENCE_API_KEY=... bun run ts/bin/cli.ts   # stdio MCP
```
