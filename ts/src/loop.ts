import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  ChatMsg,
  LoopConfig,
  LoopOutcome,
  Provider,
  Result,
  ToolCallMsg,
} from "./types.ts";
import { Err, Ok } from "./types.ts";
import { SYSTEM_PROMPT, GOAL_TEMPLATE } from "./prompts.ts";
import { EXEC_BEFORE_SATISFIED } from "./types.ts";

const DEFAULT_MAX_STEPS = 16;
const MAX_TIMEOUT_MS = 120_000;

const withinWorkdir = (workdir: string, rel: string): Result<string> => {
  const abs = path.resolve(workdir, rel);
  const norm = path.resolve(workdir) + path.sep;
  if (!abs.startsWith(norm)) return Err(`path escapes workdir: ${rel}`);
  return Ok(abs);
};

export interface ExecOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const execCode = (
  workdir: string,
  command: string,
  timeoutMs = 30_000,
): Promise<Result<ExecOutcome>> =>
  new Promise((resolve) => {
    const t = Math.min(Math.max(timeoutMs, 1000), MAX_TIMEOUT_MS);
    let stdout = "";
    let stderr = "";
    let child: import("node:child_process").ChildProcessWithoutNullStreams;
    try {
      child = spawn("/bin/bash", ["-c", command], { cwd: workdir });
    } catch (e) {
      resolve(Err(`spawn failed: ${String(e)}`));
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), t);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve(Err(String(e)));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(Ok({ code: code ?? -1, stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 4000) }));
    });
  });

export interface LoopDeps {
  readonly provider: Provider;
  readonly exec?: typeof execCode;
  readonly read?: typeof readFile;
  readonly write?: typeof writeFile;
}

interface LoopState {
  messages: ChatMsg[];
  execRuns: number;
  steps: number;
  totalTokens: number;
}

const dispatchTool = async (
  state: LoopState,
  deps: LoopDeps,
  cfg: LoopConfig,
  call: ToolCallMsg,
): Promise<{ output: string; done?: LoopOutcome }> => {
  const runExec = deps.exec ?? execCode;
  const rd = deps.read ?? readFile;
  const wr = deps.write ?? writeFile;
  if (call.name === "exec_code") {
    const command = String(call.args.command ?? "");
    const timeout = Number(call.args.timeout_ms ?? 30_000);
    const r = await runExec(cfg.workdir, command, timeout);
    if (r.ok) {
      state.execRuns += 1;
      return {
        output: `exit=${r.value.code}\nstdout:\n${r.value.stdout}\nstderr:\n${r.value.stderr}`,
      };
    }
    return { output: `exec error: ${r.error}` };
  }
  if (call.name === "read_file") {
    const p = withinWorkdir(cfg.workdir, String(call.args.path ?? ""));
    if (!p.ok) return { output: `error: ${p.error}` };
    try {
      return { output: (await rd(p.value, "utf8")).slice(0, 8000) };
    } catch (e) {
      return { output: `read error: ${String(e)}` };
    }
  }
  if (call.name === "write_file") {
    const p = withinWorkdir(cfg.workdir, String(call.args.path ?? ""));
    if (!p.ok) return { output: `error: ${p.error}` };
    try {
      await mkdir(path.dirname(p.value), { recursive: true });
      await wr(p.value, String(call.args.content ?? ""));
      return { output: `wrote ${call.args.path}` };
    } catch (e) {
      return { output: `write error: ${String(e)}` };
    }
  }
  if (call.name === "apply_patch") {
    const diff = String(call.args.diff ?? "");
    if (!diff.trim()) return { output: "error: empty diff" };
    const diffPath = path.join(cfg.workdir, `.agentic-${Date.now()}.patch`);
    try {
      await wr(diffPath, diff);
      const r = await runExec(
        cfg.workdir,
        `patchling-apply --project-dir ${JSON.stringify(cfg.workdir)} --dumb ${JSON.stringify(diffPath)} && rm -f ${JSON.stringify(diffPath)}`,
        30_000,
      );
      if (r.ok) {
        state.execRuns += 1;
        return {
          output: `exit=${r.value.code}\nstdout:\n${r.value.stdout}\nstderr:\n${r.value.stderr}`,
        };
      }
      return { output: `patch exec error: ${r.error}` };
    } catch (e) {
      return { output: `patch error: ${String(e)}` };
    }
  }
  if (call.name === "finish") {
    const verified = call.args.verified === true;
    const report = String(call.args.report ?? "");
    if (verified && state.execRuns === 0) {
      return {
        output: `REJECTED: ${EXEC_BEFORE_SATISFIED}. Run code first, then finish again.`,
      };
    }
    return {
      output: "finished",
      done: {
        satisfied: verified && state.execRuns > 0,
        report,
        steps: state.steps,
        execRuns: state.execRuns,
        totalTokens: state.totalTokens,
      },
    };
  }
  return { output: `unknown tool: ${call.name}` };
};

export const runLoop = async (
  cfg: LoopConfig,
  deps: LoopDeps,
): Promise<Result<LoopOutcome>> => {
  const maxSteps = cfg.maxSteps ?? DEFAULT_MAX_STEPS;
  const state: LoopState = {
    messages: [
      { role: "system", content: cfg.system ?? SYSTEM_PROMPT },
      { role: "user", content: GOAL_TEMPLATE(cfg.goal, cfg.workdir) },
    ],
    execRuns: 0,
    steps: 0,
    totalTokens: 0,
  };
  while (state.steps < maxSteps) {
    state.steps += 1;
    const reply = await deps.provider.chat(state.messages);
    if (!reply.ok) return Err(reply.error);
    state.totalTokens += reply.value.usage.prompt + reply.value.usage.completion;
    state.messages.push({
      role: "assistant",
      content: reply.value.content,
      ...(reply.value.toolCalls.length
        ? { tool_calls: reply.value.toolCalls }
        : {}),
    });
    if (reply.value.toolCalls.length === 0) {
      const last: string = reply.value.content ?? "";
      // model answered in prose without finishing: nudge once per step
      state.messages.push({
        role: "user",
        content:
          state.execRuns === 0
            ? `You must run code via exec_code before claiming success. ${EXEC_BEFORE_SATISFIED}.`
            : "Use the finish tool with verified=true and a factual report, or continue working.",
      });
      if (state.steps >= maxSteps) {
        return Ok({
          satisfied: false,
          report: `step budget exhausted; last model output: ${last.slice(0, 500)}`,
          steps: state.steps,
          execRuns: state.execRuns,
          totalTokens: state.totalTokens,
        });
      }
      continue;
    }
    for (const call of reply.value.toolCalls) {
      const { output, done } = await dispatchTool(state, deps, cfg, call);
      state.messages.push({ role: "tool", tool_call_id: call.id, content: output });
      if (done) return Ok(done);
    }
  }
  return Ok({
    satisfied: false,
    report: `step budget (${maxSteps}) exhausted with no finish call`,
    steps: state.steps,
    execRuns: state.execRuns,
    totalTokens: state.totalTokens,
  });
};
