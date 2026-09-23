/**
 * The environment as the model sees it.
 *
 * One object per task, holding the filesystem, the mock service, the step budget, and the
 * accounting the efficiency modifier will need. Every tool call goes through `call`, which is
 * what makes the budget and the rework count impossible to bypass by adding a tool later.
 *
 * The tool surface is the filesystem, the shell, and one tool per service operation. Not one
 * generic `api_call` tool: the choice of operation is the thing the tool-call category measures,
 * and hiding it behind a string parameter would move that choice into prose.
 */

import { MockApi } from "./api.ts";
import { MockFilesystem } from "./filesystem.ts";
import { SHELL_COMMANDS, runShellCommand } from "./shell.ts";
import type {
  ApiOperation,
  EnvSnapshot,
  ToolCall,
  ToolDefinition,
  ToolObservation,
} from "../types.ts";

export interface EnvironmentOptions {
  readonly initial: EnvSnapshot;
  readonly operations: readonly ApiOperation[];
  readonly maxSteps: number;
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): Readonly<Record<string, unknown>> {
  return { type: "object", properties, required, additionalProperties: false };
}

export const FILESYSTEM_TOOLS: readonly ToolDefinition[] = [
  {
    name: "fs_read",
    description: "Read a file. Returns its contents, or an error if it does not exist.",
    parameters: objectSchema({ path: { type: "string" } }, ["path"]),
  },
  {
    name: "fs_write",
    description: "Write a file, replacing anything already there. Creates it if needed.",
    parameters: objectSchema({ path: { type: "string" }, content: { type: "string" } }, [
      "path",
      "content",
    ]),
  },
  {
    name: "fs_append",
    description: "Append to a file. Creates it if it does not exist.",
    parameters: objectSchema({ path: { type: "string" }, content: { type: "string" } }, [
      "path",
      "content",
    ]),
  },
  {
    name: "fs_list",
    description: "List the direct children of a directory. Directories end in a slash.",
    parameters: objectSchema({ path: { type: "string" } }, []),
  },
  {
    name: "fs_remove",
    description: "Remove a file, or a directory and everything under it.",
    parameters: objectSchema({ path: { type: "string" } }, ["path"]),
  },
  {
    name: "fs_move",
    description: "Move or rename a file.",
    parameters: objectSchema({ from: { type: "string" }, to: { type: "string" } }, ["from", "to"]),
  },
  {
    name: "sh_run",
    description: `Run one shell command. Commands: ${SHELL_COMMANDS.join("; ")}.`,
    parameters: objectSchema({ command: { type: "string" } }, ["command"]),
  },
];

const JSON_SCHEMA_TYPES: Readonly<Record<string, unknown>> = {
  string: { type: "string" },
  number: { type: "number" },
  integer: { type: "integer" },
  boolean: { type: "boolean" },
  "string[]": { type: "array", items: { type: "string" } },
};

/** One tool per service operation, with its typed parameters. */
export function toolFor(operation: ApiOperation): ToolDefinition {
  const properties: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(operation.parameters)) {
    properties[name] = JSON_SCHEMA_TYPES[type] ?? { type: "string" };
  }
  return {
    name: operation.name,
    description: operation.description,
    parameters: objectSchema(properties, operation.required),
  };
}

/** Read an argument as a string, tolerating the numeric and boolean forms models emit. */
function asString(args: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = args[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** Stable signature of a call, for detecting rework. */
function signatureOf(call: ToolCall): string {
  const keys = Object.keys(call.args).sort();
  const args = keys.map((key) => `${key}=${String(call.args[key])}`).join(",");
  return `${call.name}(${args})`;
}

export class MockEnvironment {
  readonly fs: MockFilesystem;
  readonly api: MockApi;

  private readonly operations: readonly ApiOperation[];
  private readonly maxSteps: number;
  private steps = 0;
  private redundant = 0;
  private readonly seen: string[] = [];

  constructor(options: EnvironmentOptions) {
    this.fs = new MockFilesystem(options.initial.files);
    this.api = new MockApi(options.operations, options.initial.api);
    this.operations = options.operations;
    this.maxSteps = options.maxSteps;
  }

  /** Everything the model may call: the filesystem, the shell, and the service. */
  get definitions(): readonly ToolDefinition[] {
    return [...FILESYSTEM_TOOLS, ...this.operations.map(toolFor)];
  }

  get stepsUsed(): number {
    return this.steps;
  }

  get stepsRemaining(): number {
    return Math.max(0, this.maxSteps - this.steps);
  }

  get exhausted(): boolean {
    return this.steps >= this.maxSteps;
  }

  get budget(): number {
    return this.maxSteps;
  }

  /** Calls identical to an earlier call. The observable half of rework. */
  get redundantCalls(): number {
    return this.redundant;
  }

  /**
   * Invoke a tool.
   *
   * The budget is enforced here rather than by the caller, so a tool added later cannot be the
   * one that escapes it. Over-budget calls are refused rather than executed and counted.
   */
  call(call: ToolCall): ToolObservation {
    if (this.exhausted) {
      return {
        ok: false,
        output: `the step budget of ${this.maxSteps} tool calls is exhausted`,
      };
    }

    this.steps++;
    const signature = signatureOf(call);
    if (this.seen.includes(signature)) this.redundant++;
    this.seen.push(signature);

    return this.dispatch(call);
  }

  private dispatch(call: ToolCall): ToolObservation {
    const args = call.args;

    switch (call.name) {
      case "fs_read": {
        const path = asString(args, "path");
        if (path === null) return { ok: false, output: "fs_read needs a path" };
        const content = this.fs.read(path);
        return content === null
          ? { ok: false, output: `fs_read: ${path}: no such file` }
          : { ok: true, output: content };
      }

      case "fs_write":
      case "fs_append": {
        const path = asString(args, "path");
        const content = asString(args, "content") ?? "";
        if (path === null) return { ok: false, output: `${call.name} needs a path` };
        const ok = call.name === "fs_write" ? this.fs.write(path, content) : this.fs.append(path, content);
        return ok
          ? { ok: true, output: "ok" }
          : { ok: false, output: `${call.name}: ${path}: not a usable path` };
      }

      case "fs_list": {
        const path = asString(args, "path") ?? "";
        const listing = this.fs.list(path);
        return { ok: true, output: listing.length === 0 ? "" : `${listing.join("\n")}\n` };
      }

      case "fs_remove": {
        const path = asString(args, "path");
        if (path === null) return { ok: false, output: "fs_remove needs a path" };
        return this.fs.remove(path)
          ? { ok: true, output: "ok" }
          : { ok: false, output: `fs_remove: ${path}: no such file or directory` };
      }

      case "fs_move": {
        const from = asString(args, "from");
        const to = asString(args, "to");
        if (from === null || to === null) return { ok: false, output: "fs_move needs from and to" };
        return this.fs.move(from, to)
          ? { ok: true, output: "ok" }
          : { ok: false, output: `fs_move: ${from}: no such file` };
      }

      case "sh_run": {
        const command = asString(args, "command");
        if (command === null) return { ok: false, output: "sh_run needs a command" };
        const result = runShellCommand(this.fs, command);
        return result.exitCode === 0
          ? { ok: true, output: result.stdout }
          : { ok: false, output: result.stdout };
      }

      default: {
        if (this.api.operation(call.name)) return this.api.call(call.name, args);
        const available = this.definitions.map((tool) => tool.name).join(", ");
        return { ok: false, output: `no such tool "${call.name}". Available: ${available}` };
      }
    }
  }

  /** Canonical snapshot: this is what a state-diff grader compares. */
  snapshot(): EnvSnapshot {
    return { files: this.fs.snapshot(), api: this.api.snapshot() };
  }
}
