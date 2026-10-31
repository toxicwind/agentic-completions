export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = string> = Ok<T> | Err<E>;

export const Ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const Err = <E>(error: E): Err<E> => ({ ok: false, error });

export const map =
  <T, U>(f: (t: T) => U) =>
  <E>(r: Result<T, E>): Result<U, E> =>
    r.ok ? Ok(f(r.value)) : r;

export const flatMap =
  <T, U, E>(f: (t: T) => Result<U, E>) =>
  (r: Result<T, E>): Result<U, E> =>
    r.ok ? f(r.value) : r;

export interface ToolCallMsg {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface ToolResultMsg {
  readonly callId: string;
  readonly output: string;
}

export type ChatMsg =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: readonly ToolCallMsg[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ProviderReply {
  readonly content: string | null;
  readonly toolCalls: readonly ToolCallMsg[];
  readonly finishReason: string;
  readonly usage: { readonly prompt: number; readonly completion: number };
}

export interface Provider {
  chat(messages: readonly ChatMsg[]): Promise<Result<ProviderReply>>;
}

export interface LoopConfig {
  readonly goal: string;
  readonly workdir: string;
  readonly maxSteps?: number;
  readonly model?: string;
  readonly system?: string;
}

export interface LoopOutcome {
  readonly satisfied: boolean;
  readonly report: string;
  readonly steps: number;
  readonly execRuns: number;
  readonly totalTokens: number;
}

export const EXEC_BEFORE_SATISFIED =
  "satisfied requires at least one successful exec_code run";
