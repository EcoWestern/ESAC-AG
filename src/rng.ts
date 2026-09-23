/**
 * Deterministic pseudo-randomness.
 *
 * An instance depends on the dataset seed and the item id, and on nothing else. Not the run,
 * not the timestamp, not the model. That constraint is what makes two runs comparable rather
 * than merely similar, so this file is deliberately the least clever code in the repository:
 * one hash, one generator, one fingerprint, no platform-dependent behaviour.
 */

/** FNV-1a 32-bit. Used for seed derivation and instance fingerprints. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Derive a per-item seed from a dataset seed. Stable across models and runs. */
export function deriveSeed(datasetSeed: string, itemId: string): number {
  return fnv1a(`${datasetSeed}:${itemId}`);
}

/**
 * Short, stable fingerprint of a concrete instance.
 *
 * Recorded in run output so an instance can be named precisely, and so two runs can be shown to
 * have seen the same thing without either of them disclosing the dataset seed.
 */
export function fingerprint(parts: readonly (string | number)[]): string {
  return fnv1a(parts.join("\u0000")).toString(16).padStart(8, "0");
}

/** The generator contract. Small on purpose: what is not here cannot be used by accident. */
export interface Rng {
  readonly seed: number;
  next(): number;
  int(minInclusive: number, maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  sample<T>(items: readonly T[], count: number): T[];
  shuffle<T>(items: readonly T[]): T[];
  bool(probability?: number): boolean;
}

/**
 * mulberry32. Chosen for being short enough to audit at a glance and stable across platforms,
 * which is the only property that matters here.
 */
export function makeRng(seed: number): Rng {
  let state = (seed >>> 0) || 0x9e3779b9;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    seed: seed >>> 0,
    next,
    int(minInclusive: number, maxExclusive: number): number {
      if (maxExclusive <= minInclusive) {
        throw new Error(`int() needs a non-empty range, got ${minInclusive} to ${maxExclusive}`);
      }
      return minInclusive + Math.floor(next() * (maxExclusive - minInclusive));
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error("pick() from an empty list");
      return items[Math.floor(next() * items.length)]!;
    },
    sample<T>(items: readonly T[], count: number): T[] {
      if (count < 0 || count > items.length) {
        throw new Error(`sample() of ${count} from ${items.length} items`);
      }
      return rng.shuffle(items).slice(0, count);
    },
    shuffle<T>(items: readonly T[]): T[] {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const a = out[i]!;
        out[i] = out[j]!;
        out[j] = a;
      }
      return out;
    },
    bool(probability = 0.5): boolean {
      return next() < probability;
    },
  };

  return rng;
}

/**
 * A shuffled copy driven by a seed rather than by an existing generator.
 *
 * Used where an item needs a deterministic order but has no generator in scope.
 */
export function stableShuffle<T>(items: readonly T[], seed: number): T[] {
  return makeRng(seed).shuffle(items);
}
