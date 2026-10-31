// mcp_auto — MCP tool-call auto workflow: retry, validate, fall back to Qwen, satisfy by code.
// Route doctrine (AGENTS.md §3): gateway MCP is primary; on gateway failure, do NOT
// bypass — the Qwen lane is a READ-ONLY judgment fallback, never a mutating call.

import { chat, UA } from "./completions.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


export const GATEWAY = "http://127.0.0.1:25127/mcp";

export interface McpResult {
  ok: boolean;
  data: unknown | null;
  lane: "mcp" | "qwen-fallback" | "mcp->qwen";
  attempts: number;
  error?: string;
}

export const mcpResult = (
  ok: boolean,
  data: unknown | null,
  lane: McpResult["lane"],
  attempts: number,
  error?: string,
): McpResult => ({ ok, data, lane, attempts, error });

export interface CallToolOpts {
  timeoutMs?: number;
  retries?: number;
  validate?: (data: unknown) => boolean;
  fetchImpl?: typeof fetch;
  gateway?: string;
  sleepFn?: (ms: number) => Promise<void>;
}

export const callTool = async (
  serverTool: string,
  args: Record<string, unknown>,
  opts: CallToolOpts = {},
): Promise<McpResult> => {
  const [name, tool] = serverTool.split(":", 2);
  if (!name || !tool) return mcpResult(false, null, "mcp", 0, `bad server_tool: ${serverTool}`);
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const gateway = opts.gateway ?? GATEWAY;
  const doFetch = opts.fetchImpl ?? fetch;
  const doSleep = opts.sleepFn ?? sleep;
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: tool, arguments: args },
  });
  let last = "";
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await doFetch(gateway, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": UA },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const raw = (await res.json()) as {
        error?: { message?: string };
        result?: unknown;
      };
      if (raw.error) {
        last = raw.error.message ?? "jsonrpc error";
      } else {
        const data = raw.result;
        if (!opts.validate || opts.validate(data)) {
          return mcpResult(true, data, "mcp", attempt);
        }
        last = "output failed validation";
      }
    } catch (e) {
      last = String(e);
    }
    await doSleep(Math.min(2000 * attempt, 5000));
  }
  return mcpResult(false, null, "mcp", retries, last);
};

export const auto = async (
  serverTool: string,
  args: Record<string, unknown>,
  opts: CallToolOpts & { fallbackPrompt?: string; keyOverride?: string } = {},
): Promise<McpResult> => {
  const { fallbackPrompt, keyOverride, ...callOpts } = opts;
  const r = await callTool(serverTool, args, callOpts);
  if (r.ok) return r;
  if (fallbackPrompt) {
    try {
      const { text } = await chat([{ role: "user", content: fallbackPrompt }], { keyOverride });
      return mcpResult(true, { qwen_judgment: text }, "qwen-fallback", r.attempts);
    } catch (e) {
      return mcpResult(false, null, "mcp->qwen", r.attempts, `mcp: ${r.error}; qwen: ${String(e)}`);
    }
  }
  return r;
};
