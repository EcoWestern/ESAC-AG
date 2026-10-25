/**
 * The public artifact.
 *
 * One builder, used by `esac export` and by `npm run public:verify`, so the command a reader is
 * told to run and the file that ships with the repository cannot drift apart. The previous
 * arrangement had two projections of the same data and they disagreed about line endings.
 *
 * What is omitted is the point of the artifact. Hidden tests, reference solutions, and expected
 * tool arguments are what make an item gradable, so publishing them would publish the answer key.
 * Their absence is recorded rather than left to be discovered.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { instantiateAll, seedFingerprint } from "./registry.ts";
import { ESAC_VERSION_TAG } from "./version.ts";
import type { Check, Grader, Instance, Split } from "./types.ts";

/** A grader with its answers removed. */
function publicGrader(grader: Grader): Record<string, unknown> {
  switch (grader.type) {
    case "toolcall-exact":
      return { type: grader.type };
    case "state-diff":
      return { type: grader.type };
    case "hidden-tests":
      return { type: grader.type, entry: grader.entry, hidden: true };
    case "final-text-contains":
      return { type: grader.type, hidden: true };
    case "judge":
      return { type: grader.type, rubricId: grader.rubric.id };
    default: {
      const unreachable: never = grader;
      throw new Error(`unhandled grader ${JSON.stringify(unreachable)}`);
    }
  }
}

function publicChecks(checks: readonly Check[]): readonly Record<string, unknown>[] {
  return checks.map((check) => ({
    id: check.id,
    weight: check.weight,
    grader: publicGrader(check.grader),
  }));
}

function publicInstance(instance: Instance): Record<string, unknown> {
  return {
    itemId: instance.itemId,
    category: instance.category,
    fingerprint: instance.fingerprint,
    brief: instance.brief,
    initial: instance.initial,
    operations: instance.operations.map((operation) => ({
      name: operation.name,
      description: operation.description,
      required: operation.required,
      parameters: operation.parameters,
    })),
    maxSteps: instance.maxSteps,
    efficiency: instance.efficiency,
    judgeGraded: instance.judgeGraded,
    checks: publicChecks(instance.checks),
  };
}

/** The artifact body for one pool, as bytes. */
export function artifactContent(split: Split, seed: string): string {
  const instances = instantiateAll(seed);
  const header = {
    artifact: "ESAC-AG public instance snapshot",
    versionTag: ESAC_VERSION_TAG,
    pool: split,
    datasetSeedFingerprint: seedFingerprint(seed),
    itemCount: instances.length,
    note: "Hidden tests, reference solutions, expected tool arguments, and held-out material are omitted.",
  };
  const lines = [JSON.stringify({ header }), ...instances.map((instance) => JSON.stringify(publicInstance(instance)))];
  return `${lines.join("\n")}\n`;
}

/**
 * Write the artifact, or check that the file on disk is exactly what this build would produce.
 *
 * Verify compares before writing. A verifier that writes first and then compares to itself can
 * only ever fail, which makes it worse than no check at all.
 */
export function writeArtifact(
  path: string,
  split: Split,
  seed: string,
  options: { readonly verify?: boolean } = {},
): { readonly content: string; readonly itemCount: number; readonly unchanged: boolean } {
  const content = artifactContent(split, seed);
  const itemCount = instantiateAll(seed).length;

  if (options.verify) {
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = "";
    }
    return { content, itemCount, unchanged: current === content };
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return { content, itemCount, unchanged: true };
}
