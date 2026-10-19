/** Generate the reproducible public ESAC-AG instance snapshot. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PUBLIC_DATASET_SEED, ESAC_VERSION_TAG } from "../src/version.ts";
import { instantiateAll, seedFingerprint } from "../src/registry.ts";
import type { Check, Grader, Instance } from "../src/types.ts";

const output = resolve(process.cwd(), process.argv[2] ?? "public/esac-ag-v0.3-public.jsonl");

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

const instances = instantiateAll(PUBLIC_DATASET_SEED);
const header = {
  artifact: "ESAC-AG public instance snapshot",
  versionTag: ESAC_VERSION_TAG,
  pool: "public",
  datasetSeedFingerprint: seedFingerprint(PUBLIC_DATASET_SEED),
  itemCount: instances.length,
  note: "Hidden tests, reference solutions, expected tool arguments, and held-out material are omitted.",
};

const content = [JSON.stringify({ header }), ...instances.map(publicInstance)].join("\n") + "\n";
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, content, "utf8");

// The generator is also the verifier when given an existing artifact path.
if (process.argv.includes("--verify")) {
  const existing = readFileSync(output, "utf8");
  if (existing !== content) throw new Error(`${output} is not reproducible from the public seed`);
}

console.log(`wrote ${instances.length} public instances to ${output}`);
console.log(`seed fingerprint: ${header.datasetSeedFingerprint}`);
