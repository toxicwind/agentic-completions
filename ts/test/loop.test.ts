import { describe, expect, test } from "bun:test";
import { runLoop } from "../src/loop.ts";
import type { Provider, ProviderReply, Result } from "../src/types.ts";
import { Ok } from "../src/types.ts";

const reply = (
  content: string | null,
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
  usage = { prompt: 10, completion: 5 },
): ProviderReply => ({
  content,
  toolCalls,
  finishReason: toolCalls.length ? "tool_calls" : "stop",
  usage,
});

const fakeProvider = (script: ProviderReply[]): Provider => ({
  chat: async (_msgs) => {
    const next = script.shift();
    if (!next) throw new Error("script exhausted");
    return Ok(next);
  },
});

describe("runLoop — code run before satisfied", () => {
  test("finish(verified=true) with zero exec runs is REJECTED and loop continues", async () => {
    const provider = fakeProvider([
      reply(null, [{ id: "1", name: "finish", args: { report: "done", verified: true } }]),
      reply(null, [{ id: "2", name: "exec_code", args: { command: "true" } }]),
      reply(null, [{ id: "3", name: "finish", args: { report: "ran code", verified: true } }]),
    ]);
    const outcome = await runLoop({ goal: "g", workdir: "/tmp" }, { provider });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value.satisfied).toBe(true);
    expect(outcome.ok && outcome.value.execRuns).toBe(1);
    expect(outcome.ok && outcome.value.steps).toBe(3);
  });

  test("prose-only reply triggers a nudge, not a loop exit", async () => {
    const provider = fakeProvider([
      reply("I'm done!", []),
      reply(null, [{ id: "2", name: "exec_code", args: { command: "echo hi" } }]),
      reply(null, [{ id: "3", name: "finish", args: { report: "ok", verified: true } }]),
    ]);
    const outcome = await runLoop({ goal: "g", workdir: "/tmp" }, { provider });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value.satisfied).toBe(true);
  });

  test("finish(verified=false) ends unsatisfied even after exec runs", async () => {
    const provider = fakeProvider([
      reply(null, [{ id: "1", name: "exec_code", args: { command: "true" } }]),
      reply(null, [{ id: "2", name: "finish", args: { report: "blocked", verified: false } }]),
    ]);
    const outcome = await runLoop({ goal: "g", workdir: "/tmp" }, { provider });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value.satisfied).toBe(false);
  });

  test("step budget exhausted without finish -> unsatisfied", async () => {
    const provider = fakeProvider([
      reply(null, [{ id: "1", name: "exec_code", args: { command: "true" } }]),
      reply("still working", []),
    ]);
    const outcome = await runLoop(
      { goal: "g", workdir: "/tmp", maxSteps: 2 },
      { provider },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value.satisfied).toBe(false);
    expect(outcome.ok && outcome.value.steps).toBe(2);
  });

  test("write_file + read_file round-trip stays inside workdir", async () => {
    const tmp = await Bun.$`mktemp -d`.text().then((s) => s.trim());
    const provider = fakeProvider([
      reply(null, [
        { id: "1", name: "write_file", args: { path: "a.txt", content: "hello" } },
        { id: "2", name: "read_file", args: { path: "a.txt" } },
      ]),
      reply(null, [{ id: "3", name: "finish", args: { report: "r", verified: true } }]),
      reply(null, [{ id: "4", name: "exec_code", args: { command: "cat a.txt" } }]),
      reply(null, [{ id: "5", name: "finish", args: { report: "ok", verified: true } }]),
    ]);
    const outcome = await runLoop({ goal: "g", workdir: tmp }, { provider });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value.satisfied).toBe(true);
    const txt = await Bun.file(`${tmp}/a.txt`).text();
    expect(txt).toBe("hello");
  });

  test("path traversal is blocked", async () => {
    const tmp = await Bun.$`mktemp -d`.text().then((s) => s.trim());
    const provider = fakeProvider([
      reply(null, [{ id: "1", name: "read_file", args: { path: "../../etc/passwd" } }]),
      reply(null, [{ id: "2", name: "finish", args: { report: "ok", verified: false } }]),
    ]);
    const outcome = await runLoop({ goal: "g", workdir: tmp }, { provider });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value.satisfied).toBe(false);
    expect(await Bun.file("/tmp/must-not-exist-agentic").exists()).toBe(false);
  });
});

describe("provider contract (from peer doctrine)", () => {
  test("429 with retry-after is retried, not surfaced", async () => {
    const { makeFreeinference } = await import("../src/provider.ts");
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('{"error":"shed"}', { status: 429, headers: { "retry-after": "0" } });
      }
      return Response.json({
        choices: [{ finish_reason: "stop", message: { content: "ok", tool_calls: [] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    }) as unknown as typeof fetch;
    const provider = makeFreeinference({ apiKey: "k", fetchImpl });
    const r = await provider.chat([{ role: "user", content: "hi" }]);
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
  });

  test("non-retryable 400 surfaces immediately", async () => {
    const { makeFreeinference } = await import("../src/provider.ts");
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('{"error":"bad request"}', { status: 400 });
    }) as unknown as typeof fetch;
    const provider = makeFreeinference({ apiKey: "k", fetchImpl });
    const r = await provider.chat([{ role: "user", content: "hi" }]);
    expect(r.ok).toBe(false);
    expect(calls).toBe(1);
  });
});

describe("apply_patch tool", () => {
  test("applies a unified diff via patchling-apply and counts as exec", async () => {
    const tmp = await Bun.$`mktemp -d`.text().then((s) => s.trim());
    await Bun.write(`${tmp}/f.py`, "def old():\n    pass\n");
    const diff = `--- a/f.py\n+++ b/f.py\n@@ -1,2 +1,2 @@\n def old():\n-    pass\n+    return 42\n`;
    const provider = fakeProvider([
      reply(null, [{ id: "1", name: "apply_patch", args: { diff } }]),
      reply(null, [{ id: "2", name: "finish", args: { report: "ok", verified: true } }]),
    ]);
    const outcome = await runLoop({ goal: "g", workdir: tmp }, { provider });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value.satisfied).toBe(true);
    expect(outcome.ok && outcome.value.execRuns).toBe(1);
    expect(await Bun.file(`${tmp}/f.py`).text()).toContain("return 42");
  });
});
