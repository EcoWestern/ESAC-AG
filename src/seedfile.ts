/** Held-out seed generation and resolution.
 *
 * The seed is the held-out pool. It is never committed, printed by default, or included in a
 * report. Public runs use the disclosed constant; held-out runs require an explicit seed, an
 * environment variable, or the ignored seed file.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HELD_OUT_DATASET_SEED_ENV } from "./version.ts";

export const HELD_OUT_SEED_FILE = ".heldout/seed";
const PREFIX = "esac-ag-heldout-";

export function generateSeed(): string {
  return `${PREFIX}${randomBytes(32).toString("hex")}`;
}

export function readSeedFile(path = HELD_OUT_SEED_FILE): string | null {
  if (!existsSync(path)) return null;
  const value = readFileSync(path, "utf8").trim();
  return value.length > 0 ? value : null;
}

export function writeSeedFile(seed: string, options: { readonly path?: string; readonly force?: boolean } = {}): void {
  const path = options.path ?? HELD_OUT_SEED_FILE;
  if (existsSync(path) && !options.force) throw new Error(`refusing to overwrite ${path}; use --force`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${seed}\n`, "utf8");
}

export function resolveHeldOutSeed(options: {
  readonly explicit?: string;
  readonly environment?: string;
  readonly path?: string;
} = {}): string | null {
  return options.explicit?.trim() || options.environment?.trim() || readSeedFile(options.path) || null;
}

export function missingSeedMessage(): string {
  return `held-out runs need a seed: pass --seed, set ${HELD_OUT_DATASET_SEED_ENV}, or create ${HELD_OUT_SEED_FILE} with esac seed new`;
}
