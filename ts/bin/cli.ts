#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { makeFreeinference } from "../src/provider.ts";
import { runLoop } from "../src/loop.ts";

const apiKey = process.env.FREEINFERENCE_API_KEY ?? "";
const model = process.env.AGENTIC_MODEL;
const maxSteps = Number(process.env.AGENTIC_MAX_STEPS ?? 16);

const server = new McpServer({
  name: "agentic-completions",
  version: "0.1.0",
});

server.tool(
  "agentic_complete",
  "Run an autonomous agentic completion: the model works a goal in a workdir with exec/read/write tools. Satisfied only after code has actually been executed and verified.",
  {
    goal: z.string().describe("what to accomplish"),
    workdir: z.string().describe("absolute working directory"),
    max_steps: z.number().optional().describe("loop step budget (default 16)"),
  },
  async ({ goal, workdir, max_steps }) => {
    if (!apiKey) {
      return {
        content: [
          {
            type: "text",
            text: "FREEINFERENCE_API_KEY not set — inject via secretsmith env",
          },
        ],
        isError: true,
      };
    }
    const provider = makeFreeinference({ apiKey, ...(model ? { model } : {}) });
    const outcome = await runLoop(
      { goal, workdir, ...(max_steps ? { maxSteps: max_steps } : {}), ...(model ? { model } : {}) },
      { provider },
    );
    if (!outcome.ok) {
      return { content: [{ type: "text", text: `loop error: ${outcome.error}` }], isError: true };
    }
    const o = outcome.value;
    return {
      content: [
        {
          type: "text",
          text: `satisfied=${o.satisfied} steps=${o.steps} exec_runs=${o.execRuns} tokens=${o.totalTokens}\n\n${o.report}`,
        },
      ],
      isError: !o.satisfied,
    };
  },
);

await server.connect(new StdioServerTransport());
