import type { Provider, ProviderReply, Result, ChatMsg } from "./types.ts";
import { Err, Ok } from "./types.ts";

export interface FreeinferenceOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly fetchImpl?: typeof fetch;
}

export const DEFAULT_MODEL = "qwen3.6-35b";
const DEFAULT_BASE = "https://freeinference.org/v1";
// Cloudflare 1010 UA wall (anomaly #14): library-default UAs get 403.
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
// max_tokens >= 2500 floor when reasoning may engage (anomaly #1).
const MIN_TOKENS = 2500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

export const makeFreeinference = (opts: FreeinferenceOptions): Provider => {
  const model = opts.model ?? DEFAULT_MODEL;
  const base = opts.baseUrl ?? DEFAULT_BASE;
  const maxTokens = Math.max(opts.maxTokens ?? 4000, MIN_TOKENS);
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async chat(messages) {
      let lastErr = "";
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          const res = await doFetch(`${base}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "user-agent": UA,
              authorization: `Bearer ${opts.apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages,
              max_tokens: maxTokens,
              tools: AGENTIC_TOOLS,
            }),
          });
          if (!res.ok) {
            const text = (await res.text()).slice(0, 400);
            lastErr = `provider http ${res.status}: ${text}`;
            if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
              const retryAfter = Number(res.headers.get("retry-after"));
              await sleep(
                Number.isFinite(retryAfter) && retryAfter > 0
                  ? Math.min(retryAfter * 1000, 30_000)
                  : 1000 * attempt,
              );
              continue;
            }
            return Err(lastErr);
          }
          const data = (await res.json()) as {
          choices: Array<{
            finish_reason: string;
            message: {
              content: string | null;
              tool_calls?: Array<{
                id: string;
                function: { name: string; arguments: string };
              }>;
            };
          }>;
          usage?: { prompt_tokens: number; completion_tokens: number };
        };
        const choice = data.choices[0];
        if (!choice) return Err("provider returned no choices");
        const toolCalls = (choice.message.tool_calls ?? []).map((tc) => {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            args = { _raw: tc.function.arguments };
          }
          return { id: tc.id, name: tc.function.name, args };
        });
        const reply: ProviderReply = {
          content: choice.message.content,
          toolCalls,
          finishReason: choice.finish_reason,
          usage: {
            prompt: data.usage?.prompt_tokens ?? 0,
            completion: data.usage?.completion_tokens ?? 0,
          },
        };
        return Ok(reply);
      } catch (e) {
        lastErr = `provider fetch failed: ${String(e)}`;
        if (attempt < MAX_ATTEMPTS) {
          await sleep(1000 * attempt);
          continue;
        }
        return Err(lastErr);
      }
      }
      return Err(lastErr || "provider exhausted retries");
    },
  };
};

export const AGENTIC_TOOLS = [
  {
    type: "function",
    function: {
      name: "exec_code",
      description:
        "Run a shell command in the workdir and return stdout+stderr. Verification requires running code before claiming success.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "shell command to run" },
          timeout_ms: { type: "number", description: "timeout in ms (default 30000, max 120000)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file inside the workdir (path-relative, traversal-blocked).",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a file inside the workdir (path-relative, traversal-blocked).",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description:
        "Apply a unified diff to the workdir via patchling-apply --dumb (offline, deterministic, no LLM). Preferred over write_file for multi-file edits.",
      parameters: {
        type: "object",
        properties: { diff: { type: "string", description: "unified diff text" } },
        required: ["diff"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description:
        "Finish with a report. REJECTED unless at least one successful exec_code run happened first (code run before satisfied).",
      parameters: {
        type: "object",
        properties: {
          report: { type: "string" },
          verified: { type: "boolean", description: "true only if code/tests were actually run and passed" },
        },
        required: ["report", "verified"],
      },
    },
  },
] as const;
