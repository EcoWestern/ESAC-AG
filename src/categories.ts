/**
 * Category registry.
 *
 * The seven capability categories and the efficiency modifier, with their point allocations
 * fixed by the specification (constitution §6) and the modifier's split fixed by amendment
 * 001 §1. The totals are asserted at load time, so a drift is a hard failure rather than a
 * quietly wrong score.
 *
 * `implemented` is not decoration. A category with no items is not a category that scored zero,
 * it is one that was not attempted, and the scorer reports a run that covers part of the suite
 * as INCOMPLETE rather than as a score. That flag is how the harness knows the difference
 * between an empty category and a failed one.
 */

export type CategoryId =
  | "toolcall"
  | "planning"
  | "code"
  | "recovery"
  | "state"
  | "ambiguity"
  | "injection";

export interface CategoryDef {
  readonly id: CategoryId;
  readonly name: string;
  readonly points: number;
  readonly grading: "deterministic" | "judge";
  /** True once the category has items. Drawn from reality, asserted against the bank. */
  readonly implemented: boolean;
  /** What the category is for, in one line. */
  readonly measures: string;
}

export const CATEGORIES: readonly CategoryDef[] = [
  {
    id: "toolcall",
    name: "Tool-call correctness",
    points: 10,
    grading: "deterministic",
    implemented: true,
    measures: "Choosing the right operation with the right parameters on the first try.",
  },
  {
    id: "planning",
    name: "Bounded multi-step planning",
    points: 10,
    grading: "deterministic",
    implemented: true,
    measures: "Reaching a goal state within a tight step budget, with partial credit for progress.",
  },
  {
    id: "code",
    name: "Code generation and execution",
    points: 15,
    grading: "deterministic",
    implemented: true,
    measures: "Writing code that passes hidden tests when it is actually run.",
  },
  {
    id: "recovery",
    name: "Error recovery",
    points: 10,
    grading: "deterministic",
    implemented: true,
    measures: "Diagnosing a failing script or trace and fixing the cause.",
  },
  {
    id: "state",
    name: "State tracking across steps",
    points: 10,
    grading: "deterministic",
    implemented: true,
    measures: "Recalling earlier tool output accurately enough to act on it later.",
  },
  {
    id: "ambiguity",
    name: "Ambiguity handling",
    points: 5,
    grading: "judge",
    implemented: false,
    measures: "Asking about an underspecified request rather than guessing silently.",
  },
  {
    id: "injection",
    name: "Injection and safety resistance",
    points: 10,
    grading: "deterministic",
    implemented: true,
    measures: "Flagging instructions that arrive inside tool output instead of obeying them.",
  },
];

export const CATEGORY_BY_ID: ReadonlyMap<CategoryId, CategoryDef> = new Map(
  CATEGORIES.map((c) => [c.id, c]),
);

/**
 * Items per category.
 *
 * The specification gives a range for one category (2 to 3 planning tasks) and exact counts for
 * the rest. A range cannot be a bank, so this fixes the count, and `validateBank` holds the
 * bank to it. Changing a number here without changing the specification would be a drift, which
 * is why the two are asserted against each other rather than trusted.
 */
export const ITEM_COUNTS: Readonly<Record<CategoryId, number>> = {
  toolcall: 5,
  planning: 2,
  code: 3,
  recovery: 2,
  state: 2,
  ambiguity: 3,
  injection: 5,
};

/** Capability points: the seven categories. */
export const CAPABILITY_POINTS = 70;

/** The efficiency modifier, which is not a capability category. */
export const EFFICIENCY_POINTS = 5;

/** Everything. A score is always reported out of this. */
export const TOTAL_POINTS = CAPABILITY_POINTS + EFFICIENCY_POINTS;

/** Total item templates. */
export const TOTAL_ITEMS = Object.values(ITEM_COUNTS).reduce((n, c) => n + c, 0);

/** Points graded by the judge, which is the ambiguity category and nothing else. */
export const JUDGE_GRADED_POINTS = CATEGORIES.filter((c) => c.grading === "judge").reduce(
  (n, c) => n + c.points,
  0,
);

/**
 * Assert the declared distribution.
 *
 * Called before a run and by the test suite. A mismatch here means the bank and the
 * specification disagree, and the right outcome is a refusal rather than a score.
 */
export function validateDistribution(): void {
  const capability = CATEGORIES.reduce((n, c) => n + c.points, 0);
  if (capability !== CAPABILITY_POINTS) {
    throw new Error(
      `categories total ${capability} points, expected ${CAPABILITY_POINTS} (constitution §6)`,
    );
  }
  if (TOTAL_POINTS !== 75) {
    throw new Error(`total is ${TOTAL_POINTS} points, expected 75 (constitution §6)`);
  }
  const itemPoints = Object.entries(ITEM_COUNTS).reduce((n, [, count]) => n + count, 0);
  if (itemPoints !== TOTAL_ITEMS) {
    throw new Error(`item counts total ${itemPoints}, expected ${TOTAL_ITEMS}`);
  }
  for (const category of CATEGORIES) {
    const count = ITEM_COUNTS[category.id];
    if (category.implemented && count < 1) {
      throw new Error(`${category.id} is marked implemented with ${count} items`);
    }
  }
}

/** How many points one item of a category is worth. */
export function itemPointsFor(category: CategoryId): number {
  const def = CATEGORY_BY_ID.get(category);
  if (!def) throw new Error(`unknown category "${category}"`);
  return def.points / ITEM_COUNTS[category];
}
