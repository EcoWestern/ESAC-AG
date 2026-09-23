/**
 * The item registry.
 *
 * Instantiation is where two of the suite's promises are kept: an instance depends only on the
 * dataset seed and the item id, and its fingerprint is derived from its own content rather than
 * from whatever a generator chose to hash. A fingerprint computed by hand can collide when two
 * instances differ in an unhashed field, and a colliding fingerprint defeats the reason for
 * recording one at all.
 *
 * Validation is the other half. A bank that disagrees with the specification should refuse to
 * run, not produce a number nobody can audit.
 */

import { CATEGORIES, ITEM_COUNTS, validateDistribution } from "./categories.ts";
import { TOOLCALL_ITEMS } from "./items/toolcall.ts";
import { PLANNING_ITEMS } from "./items/planning.ts";
import { CODE_ITEMS } from "./items/code.ts";
import { RECOVERY_ITEMS } from "./items/recovery.ts";
import { STATE_ITEMS } from "./items/state.ts";
import { AMBIGUITY_ITEMS } from "./items/ambiguity.ts";
import { INJECTION_ITEMS } from "./items/injection.ts";
import { deriveSeed, fingerprint, fnv1a, makeRng } from "./rng.ts";
import { STEP_BUDGET } from "./version.ts";
import type { Instance, ItemTemplate } from "./types.ts";

/** Every item template, ordered by category. */
export const ALL_ITEMS: readonly ItemTemplate[] = [
  ...TOOLCALL_ITEMS,
  ...PLANNING_ITEMS,
  ...CODE_ITEMS,
  ...RECOVERY_ITEMS,
  ...STATE_ITEMS,
  ...AMBIGUITY_ITEMS,
  ...INJECTION_ITEMS,
];

export const ITEMS_BY_ID: ReadonlyMap<string, ItemTemplate> = new Map(
  ALL_ITEMS.map((item) => [item.id, item]),
);

/** Instances for a dataset seed. Deterministic. */
export function instantiateAll(datasetSeed: string): Instance[] {
  return ALL_ITEMS.map((template) => {
    const seed = deriveSeed(datasetSeed, template.id);
    const rng = makeRng(seed);
    const generated = template.generate(rng, seed);

    const instanceFingerprint = fingerprint([
      template.id,
      generated.brief,
      JSON.stringify(generated.initial),
      String(generated.maxSteps),
      generated.checks
        .map((check) => `${check.id}:${check.weight}:${JSON.stringify(check.grader)}`)
        .join("|"),
    ]);

    const judgeGraded = generated.checks.some((check) => check.grader.type === "judge");

    return {
      ...generated,
      itemId: template.id,
      category: template.category,
      seed,
      fingerprint: instanceFingerprint,
      judgeGraded,
    };
  });
}

/** Fingerprint of the dataset seed, for run records. Does not reveal the seed. */
export function seedFingerprint(datasetSeed: string): string {
  return fnv1a(datasetSeed).toString(16).padStart(8, "0");
}

/**
 * Assert that the bank matches the declared distribution.
 *
 * Called before a run and by the test suite. An empty category that claims to be implemented, or
 * an item in a category that is not, is the kind of drift that turns a benchmark into a rumour.
 */
export function validateBank(): void {
  validateDistribution();

  const seen = new Set<string>();
  for (const item of ALL_ITEMS) {
    if (seen.has(item.id)) throw new Error(`duplicate item id "${item.id}"`);
    seen.add(item.id);
  }

  for (const category of CATEGORIES) {
    const count = ALL_ITEMS.filter((item) => item.category === category.id).length;
    const declared = ITEM_COUNTS[category.id];
    if (category.implemented && count !== declared) {
      throw new Error(`${category.id} has ${count} items, and the specification fixes ${declared}`);
    }
    if (!category.implemented && count !== 0) {
      throw new Error(`${category.id} is marked unimplemented but has ${count} items`);
    }
  }

  for (const item of ALL_ITEMS) {
    if (item.measures.trim().length === 0) {
      throw new Error(`${item.id} does not say what it measures`);
    }
    const generated = item.generate(makeRng(deriveSeed("validate", item.id)), 1);
    if (generated.maxSteps < 1) throw new Error(`${item.id} has no step budget`);
    if (generated.maxSteps < STEP_BUDGET.min || generated.maxSteps > STEP_BUDGET.max) {
      throw new Error(
        `${item.id} allows ${generated.maxSteps} tool calls, outside the ${STEP_BUDGET.min} to ${STEP_BUDGET.max} the specification fixes`,
      );
    }
    if (generated.checks.length === 0) throw new Error(`${item.id} has no checks`);
    if (generated.checks.some((check) => check.weight <= 0)) {
      throw new Error(`${item.id} has a check with a non-positive weight`);
    }

    // The category's declared grading and the item's checks have to agree. A category that says
    // it is judged while its items are graded by a state diff would report a judged share of the
    // suite that does not exist, and the reverse would hide one that does.
    const declaredJudge = CATEGORIES.find((category) => category.id === item.category)?.grading === "judge";
    const usesJudge = generated.checks.some((check) => check.grader.type === "judge");
    if (declaredJudge !== usesJudge) {
      throw new Error(
        `${item.id} is in a category declared ${declaredJudge ? "judge-graded" : "deterministic"} but its checks say otherwise`,
      );
    }

    for (const check of generated.checks) {
      if (check.grader.type !== "judge") continue;
      const rubric = check.grader.rubric;
      if (rubric.criteria.length === 0) throw new Error(`${item.id} has a rubric with no criteria`);
      if (rubric.criteria.some((criterion) => criterion.weight <= 0)) {
        throw new Error(`${item.id} has a rubric criterion with a non-positive weight`);
      }
      const ids = rubric.criteria.map((criterion) => criterion.id);
      if (new Set(ids).size !== ids.length) {
        throw new Error(`${item.id} has a rubric with duplicate criterion ids`);
      }
      // A criterion id is what the judge is asked to key its answer on, so it has to be a plain
      // word rather than a sentence: a judge asked for `"is it good?"` will answer unpredictably.
      for (const id of ids) {
        if (!/^[a-z][a-z0-9-]*$/.test(id)) {
          throw new Error(`${item.id} has a rubric criterion id that is not a plain key: "${id}"`);
        }
      }
    }

    // An item that executes has to say what it executes, and an item that does not must not
    // offer a tool that would run code anyway.
    for (const check of generated.checks) {
      if (check.grader.type === "hidden-tests") {
        if (check.grader.tests.length === 0) throw new Error(`${item.id} has a hidden-test check with no tests`);
        if (!generated.execution) {
          throw new Error(`${item.id} is graded by running code but does not enable execution`);
        }
        if (generated.referenceSolution === undefined) {
          throw new Error(`${item.id} is graded by running code and ships no reference solution`);
        }
      }
    }
  }
}