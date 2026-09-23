/**
 * The toy filesystem.
 *
 * In memory, deterministic, and small on purpose. It is the substrate for the planning, code,
 * and state categories, and the reason those categories can be graded by diffing state instead
 * of by asking a judge whether something looks right.
 *
 * Paths are sandboxed. `..` is refused rather than resolved, because an environment that can
 * escape its own root is not a mock environment, and a task that accidentally writes outside it
 * would produce a grader that passes for the wrong reason.
 */

import type { EnvFiles } from "../types.ts";

export type PathResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Normalise a path into the sandbox's canonical form.
 *
 * A leading slash is accepted and means the root, because models write both forms. Everything
 * else has to stay inside: `.` is dropped, `..` is an error, and empty segments collapse.
 */
export function normalisePath(raw: string): PathResult {
  const cleaned = raw.trim().replace(/\\/g, "/");
  if (cleaned.length === 0) return { ok: false, reason: "the path is empty" };

  const segments: string[] = [];
  for (const segment of cleaned.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return { ok: false, reason: "paths cannot leave the filesystem root" };
    segments.push(segment);
  }

  if (segments.length === 0) return { ok: false, reason: "the path is empty" };
  return { ok: true, path: segments.join("/") };
}

export class MockFilesystem {
  private readonly files: Map<string, string>;

  constructor(initial: EnvFiles = {}) {
    this.files = new Map();
    for (const [path, content] of Object.entries(initial)) {
      const normalised = normalisePath(path);
      if (!normalised.ok) {
        throw new Error(`initial file "${path}" is not a valid path: ${normalised.reason}`);
      }
      this.files.set(normalised.path, content);
    }
  }

  exists(path: string): boolean {
    const normalised = normalisePath(path);
    return normalised.ok && this.files.has(normalised.path);
  }

  read(path: string): string | null {
    const normalised = normalisePath(path);
    if (!normalised.ok) return null;
    return this.files.get(normalised.path) ?? null;
  }

  write(path: string, content: string): boolean {
    const normalised = normalisePath(path);
    if (!normalised.ok) return false;
    this.files.set(normalised.path, content);
    return true;
  }

  append(path: string, content: string): boolean {
    const normalised = normalisePath(path);
    if (!normalised.ok) return false;
    const existing = this.files.get(normalised.path) ?? "";
    this.files.set(normalised.path, existing + content);
    return true;
  }

  remove(path: string): boolean {
    const normalised = normalisePath(path);
    if (!normalised.ok) return false;
    if (this.files.has(normalised.path)) return this.files.delete(normalised.path);

    // A directory is a set of paths that share a prefix, so removing one removes its contents.
    const prefix = `${normalised.path}/`;
    let removed = false;
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(prefix)) {
        this.files.delete(key);
        removed = true;
      }
    }
    return removed;
  }

  move(from: string, to: string): boolean {
    const source = normalisePath(from);
    const target = normalisePath(to);
    if (!source.ok || !target.ok) return false;
    const content = this.files.get(source.path);
    if (content === undefined) return false;
    this.files.delete(source.path);
    this.files.set(target.path, content);
    return true;
  }

  /**
   * Direct children of a directory, sorted, with a trailing slash on directories.
   *
   * Directories are inferred from paths rather than stored, which keeps one source of truth and
   * makes an empty directory impossible to create by accident.
   */
  list(dir = ""): string[] {
    const normalised = dir.trim() === "" ? { ok: true as const, path: "" } : normalisePath(dir);
    if (!normalised.ok) return [];

    const prefix = normalised.path === "" ? "" : `${normalised.path}/`;
    const names = new Set<string>();
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest.length === 0) continue;
      const slash = rest.indexOf("/");
      names.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
    }
    return [...names].sort();
  }

  /** All paths, sorted. The canonical order a snapshot is compared in. */
  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  /**
   * Replace the whole filesystem.
   *
   * Used when a generated script has run: the sandbox directory is the truth after the fact,
   * including files the script deleted, so the mock filesystem is rebuilt from it rather than
   * patched. A path that does not normalise is refused here as it is everywhere else.
   */
  replaceAll(files: EnvFiles): boolean {
    const next = new Map<string, string>();
    for (const [path, content] of Object.entries(files)) {
      const normalised = normalisePath(path);
      if (!normalised.ok) return false;
      next.set(normalised.path, content);
    }
    this.files.clear();
    for (const [path, content] of next) this.files.set(path, content);
    return true;
  }

  /** A snapshot suitable for diffing: every file, in a stable order. */
  snapshot(): EnvFiles {
    const out: Record<string, string> = {};
    for (const path of this.paths()) out[path] = this.files.get(path)!;
    return out;
  }
}
