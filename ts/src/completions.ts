import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

export const BASE = "https://freeinference.org/v1";
// Cloudflare 1010 UA wall (anomaly #14): always desktop browser UA.
export const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
export const DEFAULT_MODEL = "qwen3.6-35b";
export const MAX_TOKENS = 4000; // reasoning shares the budget; floor 2500

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Msg {
  role: "system" | "user" | "assistant";
  content: unknown;
}

export interface ChatOpts {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  retries?: number;
  imagePath?: string;
  fetchImpl?: typeof fetch;
  keyOverride?: string;
  sleepFn?: (ms: number) => Promise<void>;
}

export const getKey = async (): Promise<string> => {
  const env = process.env.FREEINFERENCE_API_KEY;
  if (env?.trim()) return env.trim();
  const r = await new Promise<string>((resolve) =>
    execFile(
      "secretsmith",
      ["get", "--label", "FREEINFERENCE_API_KEY"],
      { timeout: 30_000 },
      (err, stdout) => resolve(err ? "" : stdout),
    ),
  );
  const m = r.match(/secret: (\S+)/);
  if (!m) throw new Error("no FREEINFERENCE_API_KEY in env or keyring");
  return m[1];
};

interface RawChatResponse {
  choices: Array<{ message: { content: string | null } }>;
  usage?: Record<string, number>;
}

export interface ChatResult {
  text: string;
  usage: Record<string, number>;
}

export const chat = async (
  messages: readonly Msg[],
  opts: ChatOpts = {},
): Promise<ChatResult> => {
  const key = opts.keyOverride ?? (await getKey());
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = Math.max(opts.maxTokens ?? MAX_TOKENS, 2500);
  const temperature = opts.temperature ?? 0.2;
  const retries = opts.retries ?? 3;
  const doFetch = opts.fetchImpl ?? fetch;
  const doSleep = opts.sleepFn ?? sleep;

  let finalMessages: readonly Msg[] = messages;
  if (opts.imagePath) {
    const b64 = await readFile(opts.imagePath, "base64");
    const last = messages[messages.length - 1];
    const content = [
      { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
      { type: "text", text: String(last.content) },
    ];
    finalMessages = [...messages.slice(0, -1), { ...last, content }];
  }
  const body = JSON.stringify({ model, messages: finalMessages, max_tokens: maxTokens, temperature });

  let lastError = "";
  for (let attempt = 0; attempt < retries; attempt += 1) {
    let res: Response;
    try {
      res = await doFetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "user-agent": UA },
        body,
      });
    } catch (e) {
      lastError = String(e);
      await doSleep(1500);
      continue;
    }
    if (!res.ok) {
      lastError = `http ${res.status}`;
      if (res.status === 429) {
        await doSleep(2000 * (attempt + 1)); // observer effect: serialize, back off
        continue;
      }
      if (res.status >= 500) {
        await doSleep(1500);
        continue;
      }
      throw new Error(lastError);
    }
    const data = (await res.json()) as RawChatResponse;
    const choice = data.choices?.[0]?.message?.content ?? "";
    if (!choice.trim()) {
      lastError = "empty completion";
      continue;
    }
    return { text: choice.trim(), usage: data.usage ?? {} };
  }
  throw new Error(lastError || "chat retries exhausted");
};

export const structured = async <T = unknown>(
  messages: readonly Msg[],
  opts: { model?: string; retries?: number; keyOverride?: string } = {},
): Promise<{ data: T; usage: Record<string, number> }> => {
  const sysmsg: Msg = {
    role: "system",
    content:
      "You are a terse reviewer. Answer ONLY with a JSON object. No prose, no markdown fences.",
  };
  const repairRetries = opts.retries ?? 2;
  const { text, usage } = await chat([sysmsg, ...messages], { model: opts.model, keyOverride: opts.keyOverride });
  const tryParse = (s: string): T | null => {
    try {
      return JSON.parse(s) as T;
    } catch {
      const m = s.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          return JSON.parse(m[0]) as T;
        } catch {
          return null;
        }
      }
      return null;
    }
  };
  const first = tryParse(text);
  if (first !== null) return { data: first, usage };
  if (repairRetries <= 0) throw new Error(`model would not produce JSON: ${text.slice(0, 200)}`);
  const lastUser = String(messages[messages.length - 1].content);
  const repair = await chat(
    [
      sysmsg,
      {
        role: "user",
        content: `${lastUser}\n\nYour previous answer was not valid JSON: ${text.slice(0, 400)}\nReturn ONLY valid JSON.`,
      },
    ],
    { model: opts.model, keyOverride: opts.keyOverride },
  );
  const second = tryParse(repair.text);
  if (second === null) throw new Error(`model would not produce JSON: ${repair.text.slice(0, 200)}`);
  return { data: second, usage: repair.usage };
};

export interface CodeCheck {
  readonly name: string;
  readonly run: () => [boolean, string] | Promise<[boolean, string]>;
}

export interface SatisfyResult {
  satisfied: boolean;
  code_checks: Array<{ check: string; ok: boolean; evidence: string }>;
  judgment: string | null;
  advisory: string | null;
}

export const satisfy = async (
  checks: readonly CodeCheck[],
  judgmentPrompt: string,
  opts: { model?: string; chatFn?: typeof chat; keyOverride?: string } = {},
): Promise<SatisfyResult> => {
  const chatFn = opts.chatFn ?? chat;
  const results: SatisfyResult["code_checks"] = [];
  for (const c of checks) {
    const [ok, evidence] = await c.run();
    results.push({ check: c.name, ok: Boolean(ok), evidence: String(evidence).slice(0, 300) });
    if (!ok) {
      return { satisfied: false, code_checks: results, judgment: null, advisory: null };
    }
  }
  let verdict: string;
  try {
    const r = await chatFn(
      [
        {
          role: "system",
          content:
            "You are a skeptical reviewer. Code checks already PASSED. You may flag concerns, but you cannot declare failure the checks contradict. End with EXACTLY one line: VERDICT: PASS or VERDICT: CONCERNS.",
        },
        { role: "user", content: judgmentPrompt },
      ],
      { model: opts.model, keyOverride: opts.keyOverride },
    );
    verdict = r.text;
  } catch (e) {
    return {
      satisfied: true,
      code_checks: results,
      advisory: null,
      judgment: `(judgment lane unavailable, code-proved only: ${String(e)})`,
    };
  }
  // Code decides satisfaction; the model is advisory. A malformed verdict
  // (no VERDICT line) is a model-quirk note, never a satisfaction flip.
  const concerns = verdict.includes("VERDICT: CONCERNS");
  const malformed = !verdict.includes("VERDICT:");
  return {
    satisfied: true,
    code_checks: results,
    advisory: concerns ? "model flagged concerns" : malformed ? "model verdict malformed" : null,
    judgment: verdict,
  };
};
