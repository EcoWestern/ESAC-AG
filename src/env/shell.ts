/**
 * The mock shell.
 *
 * A command surface over the same filesystem, so a task can be solved with commands instead of
 * one file edit per turn. Kept deliberately narrow: a shell that quietly becomes a general
 * purpose interpreter stops being deterministic, and this one has to produce the same bytes on
 * every platform.
 *
 * Parsing is whitespace only. There is no quoting, no pipes, no redirection, and no globbing,
 * and that is a design decision rather than an unfinished one: a task that needs quoting is a
 * task whose failure would be about the shell rather than about the model.
 */

import type { MockFilesystem } from "./filesystem.ts";

export interface ShellResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/** Commands the shell knows, for the tool description and for error messages. */
export const SHELL_COMMANDS = [
  "ls [dir]",
  "cat <file>",
  "wc <file>",
  "write <file> <text...>",
  "append <file> <text...>",
  "rm <file>",
  "mv <from> <to>",
] as const;

function failure(message: string): ShellResult {
  return { exitCode: 1, stdout: message };
}

export function runShellCommand(fs: MockFilesystem, command: string): ShellResult {
  const trimmed = command.trim();
  if (trimmed.length === 0) return failure("the command is empty");

  const [rawName, ...rest] = trimmed.split(/\s+/);
  const name = (rawName ?? "").toLowerCase();

  switch (name) {
    case "ls": {
      const listing = fs.list(rest[0] ?? "");
      return { exitCode: 0, stdout: listing.length === 0 ? "" : `${listing.join("\n")}\n` };
    }

    case "cat": {
      const path = rest[0];
      if (!path) return failure("cat needs a file");
      const content = fs.read(path);
      if (content === null) return failure(`cat: ${path}: no such file`);
      return { exitCode: 0, stdout: content };
    }

    case "wc": {
      const path = rest[0];
      if (!path) return failure("wc needs a file");
      const content = fs.read(path);
      if (content === null) return failure(`wc: ${path}: no such file`);
      const lines = content.length === 0 ? 0 : content.split("\n").filter((l) => l.length > 0).length;
      const words = content.split(/\s+/).filter((w) => w.length > 0).length;
      return { exitCode: 0, stdout: `${lines} ${words} ${content.length}\n` };
    }

    case "write":
    case "append": {
      const path = rest[0];
      if (!path) return failure(`${name} needs a file`);
      const text = rest.slice(1).join(" ");
      const ok = name === "write" ? fs.write(path, text) : fs.append(path, text);
      return ok ? { exitCode: 0, stdout: "" } : failure(`${name}: ${path}: not a usable path`);
    }

    case "rm": {
      const path = rest[0];
      if (!path) return failure("rm needs a file");
      return fs.remove(path) ? { exitCode: 0, stdout: "" } : failure(`rm: ${path}: no such file`);
    }

    case "mv": {
      const from = rest[0];
      const to = rest[1];
      if (!from || !to) return failure("mv needs a source and a destination");
      return fs.move(from, to) ? { exitCode: 0, stdout: "" } : failure(`mv: ${from}: no such file`);
    }

    default:
      return failure(`unknown command "${name}". Available: ${SHELL_COMMANDS.join(", ")}`);
  }
}
