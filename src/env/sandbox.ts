/**
 * Running generated code without letting it touch the machine.
 *
 * The suite has to run code the model wrote. That is the only way to grade whether the code
 * works, and it is also the only part of this repository that could damage the machine it runs
 * on, so the design starts from what the child is unable to do rather than from what it is
 * asked to do.
 *
 * The child is started under Node's permission model with every capability switched off except
 * read and write inside one throwaway directory:
 *
 *   - it cannot read anything outside that directory, so it cannot read keys, config, or the
 *     repository itself;
 *   - it cannot write outside it, so it cannot overwrite or delete anything that matters;
 *   - it cannot start a process or a worker thread, and it cannot load a native addon, so it
 *     cannot shell out to something that has no such limits;
 *   - it inherits a hand-built environment containing no key, no token, and no proxy setting;
 *   - it is killed after a fixed wall-clock limit, with a heap cap, and its output is capped.
 *
 * Two things this does not do, stated rather than implied:
 *
 *   - the permission model does not restrict network access, because Node has no per-process
 *     network permission. A script could open a socket. There is nothing to exfiltrate from the
 *     environment it is given, and the tasks are offline by construction, but the hole is real
 *     and it is the reason the environment carries no secrets at all.
 *   - the caps are limits on the child, not a container. They are enforced by Node and by the
 *     parent process, not by the operating system.
 *
 * The design principle that matters most: this **fails closed**. Before anything is executed,
 * the sandbox proves that the permission model is actually enforcing, by writing a file it is
 * allowed to write, failing to read a file it is not allowed to read, and failing to start a
 * process. If any of those three behaves differently, the sandbox refuses to run anything and
 * the tasks that need it are reported as not run rather than run unsafely.
 */

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import { normalisePath } from "./filesystem.ts";
import { EXECUTION } from "../version.ts";
import type { EnvFiles } from "../types.ts";

export type SandboxStatus =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface SandboxRun {
  /** False when the sandbox refused to execute. The run then has no exit code and no output. */
  readonly ran: boolean;
  readonly refusal: string | null;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** Every file the child left behind, keyed by the same paths the mock filesystem uses. */
  readonly files: EnvFiles;
}

/**
 * The environment the child inherits.
 *
 * Built from nothing rather than filtered, so a secret added to the parent later cannot leak by
 * being forgotten here. Windows needs a system root to start a process at all, which is the only
 * reason anything from outside appears.
 */
function childEnvironment(sandboxDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["SystemRoot", "SYSTEMROOT", "windir", "WINDIR"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env["TEMP"] = sandboxDir;
  env["TMP"] = sandboxDir;
  env["TMPDIR"] = sandboxDir;
  env["NO_COLOR"] = "1";
  return env;
}

/** Write a set of files into a directory, creating parents, refusing escapes. */
function materialise(dir: string, files: EnvFiles): void {
  for (const [path, content] of Object.entries(files)) {
    const normalised = normalisePath(path);
    if (!normalised.ok) throw new Error(`cannot place "${path}": ${normalised.reason}`);
    const target = join(dir, ...normalised.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

/**
 * Read a directory back into a file map.
 *
 * Text only, because the mock filesystem is text and a task that writes a PNG is not a task this
 * suite has. A file that is not valid text is recorded as a placeholder carrying its size, so a
 * state diff still notices that it changed without comparing bytes.
 */
function collect(dir: string, limits = EXECUTION): EnvFiles {
  const out: Record<string, string> = {};
  let count = 0;

  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (count >= limits.maxFiles) return;
      const key = relative(dir, full).split(sep).join("/");
      const size = statSync(full).size;
      count++;
      if (size > limits.maxFileBytes) {
        out[key] = `[${size} bytes, too large to compare]`;
        continue;
      }
      const raw = readFileSync(full);
      if (raw.includes(0)) {
        out[key] = `[${size} bytes of binary]`;
        continue;
      }
      out[key] = raw.toString("utf8");
    }
  };

  walk(dir);
  return out;
}

/** Run one probe script under the permission model and report what happened. */
function probeRun(
  args: readonly string[],
  code: string,
  options: { readonly script: string; readonly cwd: string; readonly env: Record<string, string> },
): { readonly code: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(process.execPath, [...args, "-e", code], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: EXECUTION.timeoutMs,
    maxBuffer: EXECUTION.maxOutputBytes,
  });
  return {
    code: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

/**
 * Prove that the permission model is enforcing, before anything runs.
 *
 * Three checks, because they can fail independently: a build where `--permission` is accepted
 * but not enforced would pass a write check and fail nothing else. The read check requires the
 * specific `ERR_ACCESS_DENIED` code, since a missing file would throw too and would look like a
 * pass for the wrong reason.
 *
 * Cached, because it costs three process starts.
 */
let cachedStatus: SandboxStatus | null = null;

export function sandboxStatus(): SandboxStatus {
  if (cachedStatus !== null) return cachedStatus;

  if (process.env["ESAC_AG_NO_EXEC"] === "1") {
    cachedStatus = { ok: false, reason: "execution was disabled with ESAC_AG_NO_EXEC=1" };
    return cachedStatus;
  }

  const base = mkdtempSync(join(tmpdir(), "esac-ag-probe-"));
  try {
    const allowed = join(base, "allowed");
    const other = join(base, "other");
    mkdirSync(allowed, { recursive: true });
    mkdirSync(other, { recursive: true });
    const forbidden = join(other, "secret.txt");
    writeFileSync(forbidden, "secret", "utf8");

    const flags = [
      "--permission",
      "--disable-warning=ExperimentalWarning",
      `--allow-fs-read=${allowed}`,
      `--allow-fs-write=${allowed}`,
    ];
    const env = childEnvironment(base);
    const target = join(allowed, "written.txt");

    const writeProbe = probeRun(
      flags,
      `import('node:fs').then((fs) => { fs.writeFileSync(${JSON.stringify(target)}, 'x'); process.exit(0); }).catch(() => process.exit(9));`,
      { script: "write", cwd: allowed, env },
    );
    if (writeProbe.code !== 0) {
      cachedStatus = {
        ok: false,
        reason: "the permission model would not let a script write inside its own directory",
      };
      return cachedStatus;
    }

    const readProbe = probeRun(
      flags,
      `import('node:fs').then((fs) => { fs.readFileSync(${JSON.stringify(forbidden)}, 'utf8'); process.exit(9); }).catch((error) => process.exit(error && error.code === 'ERR_ACCESS_DENIED' ? 0 : 9));`,
      { script: "read", cwd: allowed, env },
    );
    if (readProbe.code !== 0) {
      cachedStatus = {
        ok: false,
        reason: "the permission model did not deny a read outside the sandbox",
      };
      return cachedStatus;
    }

    const spawnProbe = probeRun(
      flags,
      `import('node:child_process').then((cp) => { cp.execSync('echo x'); process.exit(9); }).catch((error) => process.exit(error && error.code === 'ERR_ACCESS_DENIED' ? 0 : 9));`,
      { script: "spawn", cwd: allowed, env },
    );
    if (spawnProbe.code !== 0) {
      cachedStatus = {
        ok: false,
        reason: "the permission model did not deny starting a child process",
      };
      return cachedStatus;
    }

    cachedStatus = { ok: true };
    return cachedStatus;
  } catch (error) {
    cachedStatus = {
      ok: false,
      reason: `the sandbox could not be probed: ${error instanceof Error ? error.message : String(error)}`,
    };
    return cachedStatus;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** Reset the probe. Tests only. */
export function forgetSandboxStatus(): void {
  cachedStatus = null;
}

export interface SandboxRequest {
  readonly files: EnvFiles;
  /** Path of the script to run, as it appears in `files`. */
  readonly entry: string;
  /** Written to the child's stdin, then closed. */
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly memoryMb?: number;
}

/**
 * Run one script in a throwaway directory.
 *
 * The directory is created, filled with the model's files, used once, read back, and deleted.
 * Nothing persists between runs, so two runs of the same script see the same world.
 */
export function runInSandbox(request: SandboxRequest): SandboxRun {
  const status = sandboxStatus();
  if (!status.ok) {
    return {
      ran: false,
      refusal: status.reason,
      exitCode: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      files: {},
    };
  }

  const entry = normalisePath(request.entry);
  if (!entry.ok) {
    return {
      ran: false,
      refusal: `the entry path is not usable: ${entry.reason}`,
      exitCode: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      files: {},
    };
  }

  const timeoutMs = request.timeoutMs ?? EXECUTION.timeoutMs;
  const memoryMb = request.memoryMb ?? EXECUTION.memoryMb;
  const dir = mkdtempSync(join(tmpdir(), "esac-ag-run-"));

  try {
    materialise(dir, request.files);

    const result = spawnSync(
      process.execPath,
      [
        "--permission",
        "--disable-warning=ExperimentalWarning",
        `--max-old-space-size=${memoryMb}`,
        `--allow-fs-read=${dir}`,
        `--allow-fs-write=${dir}`,
        join(dir, ...entry.path.split("/")),
      ],
      {
        cwd: dir,
        env: childEnvironment(dir),
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: EXECUTION.maxOutputBytes,
        input: request.stdin ?? "",
        windowsHide: true,
      },
    );

    const timedOut =
      result.error !== undefined &&
      (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";

    // A killed child has no exit code, and reporting one would invent a result.
    return {
      ran: true,
      refusal: null,
      exitCode: result.status,
      timedOut,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      files: collect(dir),
    };
  } catch (error) {
    return {
      ran: false,
      refusal: `the sandbox could not run the script: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      files: {},
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One line describing the sandbox, for `esac sandbox` and for run reports. */
export function describeSandbox(): string {
  const status = sandboxStatus();
  if (status.ok) {
    return `available: a ${EXECUTION.timeoutMs} ms wall-clock limit, a ${EXECUTION.memoryMb} MB heap, no reads or writes outside a throwaway directory, no child processes, no environment.`;
  }
  return `unavailable: ${status.reason}. Tasks that need execution will be reported as not run.`;
}
