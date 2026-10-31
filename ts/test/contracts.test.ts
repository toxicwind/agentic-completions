import { describe, expect, test } from "bun:test";
import { satisfy, chat, type Msg } from "../src/completions.ts";
import { auto, callTool } from "../src/mcp-auto.ts";

// Pin the REAL contracts (ported from test_agentic.py, audit 2026-10-31).

const fakeChat = (verdict: string) =>
  (async () => ({ text: verdict, usage: {} })) as unknown as typeof chat;

describe("satisfy gate (code-run-first)", () => {
  test("failed code check blocks model consult", async () => {
    let consulted = 0;
    const res = await satisfy([{ name: "bad", run: () => [false, "nope"] }], "p", {
      chatFn: (async () => {
        consulted += 1;
        return { text: "VERDICT: PASS", usage: {} };
      }) as typeof chat,
    });
    expect(res.satisfied).toBe(false);
    expect(res.judgment).toBe(null);
    expect(consulted).toBe(0);
  });

  test("passing code check is satisfaction even with model CONCERNS", async () => {
    const res = await satisfy([{ name: "ok", run: () => [true, "ev"] }], "p", {
      chatFn: fakeChat("VERDICT: CONCERNS whatever"),
    });
    expect(res.satisfied).toBe(true);
    expect(res.advisory).toBe("model flagged concerns");
  });

  test("malformed verdict is advisory note, never a flip", async () => {
    const res = await satisfy([{ name: "ok", run: () => [true, "ev"] }], "p", {
      chatFn: fakeChat("looks fine to me"),
    });
    expect(res.satisfied).toBe(true);
    expect(res.advisory).toBe("model verdict malformed");
  });

  test("judgment lane failure keeps code-proved satisfaction", async () => {
    const res = await satisfy([{ name: "ok", run: () => [true, "ev"] }], "p", {
      chatFn: (async () => {
        throw new Error("lane down");
      }) as unknown as typeof chat,
    });
    expect(res.satisfied).toBe(true);
    expect(res.judgment?.includes("code-proved only")).toBe(true);
  });
});

describe("chat retry contract", () => {
  test("429 x2 then success retries to completion", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      if (n <= 2) return new Response("too fast", { status: 429 });
      return Response.json({
        choices: [{ message: { content: "hi" } }],
        usage: { completion_tokens: 1 },
      });
    }) as unknown as typeof fetch;
    const r = await chat([{ role: "user", content: "x" }], { retries: 4, fetchImpl, keyOverride: "k", sleepFn: async () => {} });
    expect(r.text).toBe("hi");
    expect(n).toBe(3);
  });

  test("4xx (non-429) fails fast, no retry", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return new Response("bad", { status: 400 });
    }) as unknown as typeof fetch;
    let threw = false;
    try {
      await chat([{ role: "user", content: "x" }], { fetchImpl, keyOverride: "k", sleepFn: async () => {} });
    } catch (e) {
      threw = String(e).includes("400");
    }
    expect(threw).toBe(true);
    expect(n).toBe(1);
  });
});

describe("mcp_auto routing", () => {
  test("gateway success uses mcp lane, never falls back", async () => {
    const fetchImpl = (async () =>
      Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } })) as unknown as typeof fetch;
    const r = await callTool("ffs:search", { q: "x" }, { fetchImpl, retries: 2 });
    expect(r.ok).toBe(true);
    expect(r.lane).toBe("mcp");
  });

  test("total gateway failure + no fallback prompt fails loudly", async () => {
    const fetchImpl = (async () => {
      throw new Error("conn refused");
    }) as unknown as typeof fetch;
    const r = await callTool("ffs:search", { q: "x" }, { fetchImpl, retries: 2, sleepFn: async () => {} });
    expect(r.ok).toBe(false);
    expect(r.lane).toBe("mcp");
  });

  test("qwen fallback only when fallback_prompt given, and is labeled", async () => {
    const fetchImpl = (async () => {
      throw new Error("conn refused");
    }) as unknown as typeof fetch;
    const r = await auto("ffs:search", { q: "x" }, {
      fetchImpl,
      retries: 1,
      fallbackPrompt: "judge this",
      keyOverride: "k",
      // chat would hit network without keyOverride; provide env stub instead
    });
    // either qwen-fallback success (if key env present) or mcp->qwen failure — never a silent mcp success
    expect(["qwen-fallback", "mcp->qwen"]).toContain(r.lane);
  });

  test("validation failure triggers retry then loud failure", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return Response.json({ jsonrpc: "2.0", id: 1, result: { bad: true } });
    }) as unknown as typeof fetch;
    const r = await callTool("ffs:search", { q: "x" }, {
      fetchImpl,
      retries: 2,
      sleepFn: async () => {},
      validate: (d) => Boolean((d as { good?: boolean })?.good),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("validation");
    expect(n).toBe(2);
  });
});
