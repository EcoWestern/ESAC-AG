/**
 * Model access.
 *
 * Two adapters. The oracle is a scripted model that answers from an answer key, which exists so
 * the harness can be tested end to end without a network and without measuring anything. The
 * HTTP adapter speaks the OpenAI chat-completions shape with tool calling, so any compatible
 * endpoint works and no provider-specific code exists here.
 *
 * Failure classification lives in this file because this is where the wire is. A transport
 * error, a bad status, or an unparseable body is infrastructure: retried, never scored. A
 * response that ran out of output budget with nothing usable in it is a model failure: scored,
 * not retried, because the same budget reaches the same conclusion.
 */

import { InfrastructureError, ModelTimeoutError, ModelTruncatedError } from "./types.ts";
import type { AgentAdapter, ChatMessage, ModelRequest, ModelTurn, ToolCall } from "./types.ts";

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

export interface OracleAgent extends AgentAdapter {
  /** Brief to the call the oracle should make. Filled by the caller from the item bank. */
  readonly key: Map<string, ToolCall>;
}

/**
 * A scripted model.
 *
 * On the first turn it makes the call it has been told to make, if any; afterwards it stops. It
 * reports no tokens, because it consumes none, and a run against it is a harness check rather
 * than a measurement.
 */
export function createOracleAgent(key: Map<string, ToolCall> = new Map()): OracleAgent {
  const turnsTaken = new Map<string, number>();

  return {
    id: "oracle",
    key,
    async complete(request: ModelRequest): Promise<ModelTurn> {
      const brief = request.messages.find((message) => message.role === "user")?.content ?? "";
      const turn = turnsTaken.get(brief) ?? 0;
      turnsTaken.set(brief, turn + 1);

      const call = key.get(brief);
      if (turn === 0 && call) {
        return {
          text: "",
          calls: [{ id: "oracle_call_0", name: call.name, args: call.args }],
          finishReason: "tool_calls",
          promptTokens: 0,
          completionTokens: 0,
        };
      }

      return {
        text: "Done.",
        calls: [],
        finishReason: "stop",
        promptTokens: 0,
        completionTokens: 0,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface HttpAgentOptions {
  readonly id: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string | undefined;
  /** Request timeout. A timeout is a model failure, not infrastructure: the model was too slow. */
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

interface RawToolCall {
  readonly id?: string;
  readonly type?: string;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

interface RawResponse {
  readonly choices?: readonly {
    readonly message?: { readonly content?: unknown; readonly tool_calls?: readonly RawToolCall[] };
    readonly finish_reason?: string;
  }[];
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
}

function toWireMessages(messages: readonly ChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls.map((call, index) => ({
          id: call.id ?? `call_${index}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      };
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId ?? "call_0",
      };
    }
    return { role: message.role, content: message.content };
  });
}

function parseToolCalls(raw: readonly RawToolCall[] | undefined): ToolCall[] {
  if (!raw || raw.length === 0) return [];
  return raw.map((entry, index) => {
    const name = entry.function?.name ?? "";
    const rawArgs = entry.function?.arguments ?? "";
    let args: Record<string, unknown> = {};
    if (rawArgs.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(rawArgs);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed arguments are the model's problem, not the harness's: the call is preserved
        // with empty arguments so the grader rejects it, rather than being retried as if the
        // transport had failed.
        args = {};
      }
    }
    return { id: entry.id ?? `call_${index}`, name, args };
  });
}

export function createHttpAgent(options: HttpAgentOptions): AgentAdapter {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    id: options.id,

    async complete(request: ModelRequest): Promise<ModelTurn> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: options.model,
            messages: toWireMessages(request.messages),
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
            tool_choice: "auto",
            temperature: request.temperature,
            max_tokens: request.maxTokens,
          }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (controller.signal.aborted) throw new ModelTimeoutError(`the request timed out: ${message}`);
        throw new InfrastructureError(`the request failed: ${message}`);
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new InfrastructureError(
          `the endpoint answered ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        );
      }

      let raw: RawResponse;
      try {
        raw = (await response.json()) as RawResponse;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new InfrastructureError(`the response body was not JSON: ${message}`);
      }

      const choice = raw.choices?.[0];
      if (!choice) throw new InfrastructureError("the response contained no choices");

      const promptTokens = raw.usage?.prompt_tokens ?? 0;
      const completionTokens = raw.usage?.completion_tokens ?? 0;
      const text = typeof choice.message?.content === "string" ? choice.message.content : "";
      const finishReason = choice.finish_reason ?? "stop";
      const calls = parseToolCalls(choice.message?.tool_calls);

      if (text.trim().length === 0 && calls.length === 0 && finishReason === "length") {
        throw new ModelTruncatedError(
          "the response ran out of output budget before producing anything usable",
          promptTokens,
          completionTokens,
        );
      }

      return { text, calls, finishReason, promptTokens, completionTokens };
    },
  };
}
