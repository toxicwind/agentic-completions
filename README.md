<div align="center">

<h1>⚡ agentic-completions</h1>

<p><strong>Autonomous code-run-first agentic completion harness & MCP stdio workflow powered by Qwen & FreeInference</strong></p>

[![repo](https://img.shields.io/badge/github-toxicwind%2Fagentic--completions-181717.svg?style=for-the-badge&logo=github&logoColor=white)](https://github.com/toxicwind/agentic-completions)
[![version](https://img.shields.io/badge/version-v1.2-blue.svg?style=for-the-badge)](https://github.com/toxicwind/agentic-completions)
[![tests](https://img.shields.io/badge/tests-19%20passed-brightgreen.svg?style=for-the-badge&logo=bun)](https://github.com/toxicwind/agentic-completions)
[![runtime](https://img.shields.io/badge/runtime-bun%201.4.4-fbf0df.svg?style=for-the-badge&logo=bun&logoColor=black)](https://bun.sh)
[![license](https://img.shields.io/badge/license-MIT-green.svg?style=for-the-badge)](LICENSE)

</div>

---

Born from production engineering where model-backed MCP judgment routinely hallucinated or 400'd — **agentic-completions** replaces brittle LLM assertions with an uncompromising runtime principle: **run the code first, verify ground-truth output, and only then consult the model.**

```
               [ User / Rig / MCP Client ]
                            │
               ┌────────────▼─────────────┐
               │    agentic_complete      │
               └────────────┬─────────────┘
                            │
             ┌──────────────┴──────────────┐
             │   Monadic Agentic Loop      │
             │   • exec_code (bash)        │
             │   • read_file / write_file  │
             │   • apply_patch (patchling) │
             └──────────────┬──────────────┘
                            │
           ┌────────────────┴────────────────┐
           │   Code-Run-First Gatekeeper     │
           │   satisfy() : [tests, builds]   │
           └────────────────┬────────────────┘
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
 [ ✅ Exec Passed ]               [ ❌ Exec Failed ]
         │                                 │
 [ Consult Qwen3.6-35B ]         [ Loop Continues / Blocked ]
         │
 [ Verified Completion ]
```

---

## 🛡️ Core Doctrines

| Rule | Principle | Why it matters |
|---|---|---|
| **1. Code proves; model advises** | `satisfy()` executes deterministic code gates first | A passing test suite is canonical satisfaction. The model can flag advisory concerns, but cannot overturn code proof. |
| **2. Declared ≠ Observed** | Live behavioral probing over documentation | Provider `/v1/models` lists claim limited capabilities; live testing proves `qwen3.6-35b` accepts multimodal vision payloads. |
| **3. Cloudflare UA Bypass** | Desktop browser User-Agent masking | Evades Cloudflare 1010 blocks that reject default HTTP client user agents. |
| **4. Dynamic Reasoning Floor** | `max_tokens ≥ 2500` floor | Prevents reasoning models from exhausting their token allocation on thinking traces. |
| **5. Gateway SSOT** | Primary gateway with labeled read-only fallback | MCP mutations always fail loudly; read-only judgments degrade gracefully to labeled `qwen-fallback`. |

---

## 🚀 Quickstart

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
import { embed, cosine } from "./ts/src/completions.ts";
const [a, b] = await embed(["goal text", "file body"]);   // bge-m3, 1024 dims, free
cosine(a, b);                                              // semantic file matching

const r = await auto("server:tool", args, { validate: Boolean });              // gateway -> qwen fallback
const o = await runLoop({ goal, workdir }, { provider });                      // agentic loop; finish gated on exec
```

---

## 🔌 MCP Stdio Server

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

## Lanes (verified live 2026-10-31)
- **chat/vision**: qwen3.6-35b (image input despite model card), glm-5.3-flash (1M ctx, thinking, recommended), deepseek-v4-flash
- **embeddings**: bge-m3 — 1024 dims FIXED (`dimensions` param -> 530), `base64` encoding_format works, free, 8192 ctx
- **docs-vs-live**: minimax-m3 documented Free but 404 on free keys (access-filtered catalog); `X-Reasoning-Passthrough:false` strips reasoning_content but starves qwen content (use passthrough default)
- **Anthropic-compat**: /v1/messages + anthropic-beta header; **batches** for internal accounts; **/v1/qdrant/** proxy with api-key header
