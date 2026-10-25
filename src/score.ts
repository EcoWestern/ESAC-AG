/**
 * Scoring and reporting.
 *
 * Four rules from the specification shape this file, and each is easy to get subtly wrong:
 *
 *   1. **A category is scored against its full allocation**, not against the items that happened
 *      to run. A category short of items still has to reach the threshold, so a missing item
 *      cannot quietly become a free pass.
 *   2. **Passing requires both thresholds.** Sixty percent in every category and sixty percent
 *      overall, so strength in one category cannot average away a hole in another.
 *   3. **A run that did not cover the suite is INCOMPLETE, not a score.** A filtered run has no
 *      comparable total, and the report says so in words rather than letting the percentage be
 *      quoted on its own.
 *   4. **A run under a substituted judge is NOT VALID rather than a score.** The judged share of
 *      the suite is an answer to a different question when the judge is a different model, and
 *      that is worse to quote than a run that is merely incomplete, so it takes precedence over
 *      the coverage rule above.
 *
 * The arithmetic gate is computed even when the run is incomplete or invalid, because it is the
 * number a valid completed run would be judged on, and hiding it would make comparison harder.
 */

import {
  CAPABILITY_POINTS,
  CATEGORIES,
  JUDGE_GRADED_POINTS,
  TOTAL_ITEMS,
  TOTAL_POINTS,
  itemPointsFor,
  type CategoryId,
} from "./categories.ts";
import {
  ESAC_AG_FULL_NAME,
  ESAC_IMPLEMENTATION_VERSION,
  ESAC_STATUS,
  ESAC_SUITE,
  ESAC_VERSION_TAG,
  EFFICIENCY,
  PASS_THRESHOLD,
  PINNED_JUDGE,
  REPLICATION,
} from "./version.ts";
import type {
  CategoryScore,
  CheckResult,
  EndedBecause,
  ItemRunResult,
  RunReport,
  Verdict,
} from "./types.ts";

/** What a run produced for one item, before points are attached. */
export interface ItemOutcome {
  readonly itemId: string;
  readonly category: CategoryId;
  readonly fraction: number;
  readonly checks: readonly CheckResult[];
  readonly steps: number;
  readonly endedBecause: EndedBecause;
  readonly redundantCalls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly efficiency?: import("./types.ts").EfficiencyEnvelope;
  /** Two for a judged item, one otherwise. */
  readonly modelRuns: number;
  /** Mean of the individual judgments, or null for an item that was not judged. */
  readonly judgeFraction: number | null;
}

export interface ScoreInput {
  readonly items: readonly ItemOutcome[];
  readonly model: string;
  readonly datasetSeedFingerprint: string;
  readonly split?: import("./types.ts").Split;
  readonly durationMs: number;
  /** Model used as the judge, or null when the run contained no judged items. */
  readonly judge?: string | null;
  /**
   * Whether that judge was the pinned one.
   *
   * Defaults to true, which is the honest default only because a run with no judged items has no
   * judge to substitute. A caller that ran a judged item has to say which judge it used.
   */
  readonly judgePinned?: boolean;
}

function localEfficiencyScore(
  outcome: ItemOutcome,
): number {
  if (outcome.endedBecause !== "final" || outcome.fraction < 1) return 0;
  const envelope = outcome.efficiency ?? {
    referenceActions: 1,
    maximumActions: 15,
    referenceTokens: 512,
    maximumTokens: 4096,
  };
  const actionSpan = Math.max(1, envelope.maximumActions - envelope.referenceActions);
  const tokenSpan = Math.max(1, envelope.maximumTokens - envelope.referenceTokens);
  const actions = outcome.steps + outcome.redundantCalls;
  const action = Math.max(0, Math.min(1, (envelope.maximumActions - actions) / actionSpan));
  const tokens = outcome.promptTokens + outcome.completionTokens;
  const token = Math.max(0, Math.min(1, (envelope.maximumTokens - tokens) / tokenSpan));
  // Reference-level work is 6, the authored maximum is 1. The lower bound is intentionally
  // nonzero only for completed work, while failed or incomplete tasks earn zero above.
  return 1 + 5 * (3.5 * action + 1.5 * token) / 5;
}

/**
 * Tolerance on the threshold comparison.
 *
 * Item weights are fractional, so a category that is exactly at the threshold mathematically can
 * land a hair below it in binary floating point, and failing on that would be a defect in the
 * arithmetic rather than a finding about the model.
 */
const THRESHOLD_EPSILON = 1e-9;

function meetsThreshold(value: number, threshold: number): boolean {
  return value >= threshold - THRESHOLD_EPSILON;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function scoreRun(input: ScoreInput): RunReport {
  const items: ItemRunResult[] = input.items.map((outcome) => {
    const points = itemPointsFor(outcome.category);
    return {
      itemId: outcome.itemId,
      category: outcome.category,
      points,
      fraction: outcome.fraction,
      awarded: round(outcome.fraction * points),
      checks: outcome.checks,
      steps: outcome.steps,
      endedBecause: outcome.endedBecause,
      redundantCalls: outcome.redundantCalls,
      promptTokens: outcome.promptTokens,
      completionTokens: outcome.completionTokens,
      judgeGraded: outcome.judgeFraction !== null,
      modelRuns: outcome.modelRuns,
      judgeFraction: outcome.judgeFraction,
    };
  });

  const categories: CategoryScore[] = CATEGORIES.map((def) => {
    const inCategory = items.filter((row) => row.category === def.id);
    // Round once at the category boundary. Rounding each item first creates phantom points when
    // an allocation does not divide evenly, such as five ambiguity points over three items:
    // 1.666667 * 3 is 5.000001. The item report may show rounded display points, but the score
    // gate must use the authored allocation, not accumulated display rounding.
    const awarded = round(
      input.items
        .filter((outcome) => outcome.category === def.id)
        .reduce((sum, outcome) => sum + outcome.fraction * itemPointsFor(outcome.category), 0),
    );
    const normalized = def.points > 0 ? awarded / def.points : 0;
    return {
      id: def.id,
      name: def.name,
      points: def.points,
      awarded,
      normalized,
      itemCount: inCategory.length,
      implemented: def.implemented,
      judgeGraded: def.grading === "judge",
      passed: inCategory.length === 0 ? true : meetsThreshold(normalized, PASS_THRESHOLD.perCategory),
    };
  });

  const successful = input.items.filter((outcome) => outcome.endedBecause === "final" && outcome.fraction >= 1);
  const efficiencyLocal = successful.length === 0
    ? 0
    : successful.reduce((sum, outcome) => sum + localEfficiencyScore(outcome), 0) / successful.length;
  const efficiencyAwarded = successful.length === 0
    ? 0
    : round((EFFICIENCY.points * Math.max(0, efficiencyLocal - 1)) / 5);
  const total = round(categories.reduce((sum, category) => sum + category.awarded, 0) + efficiencyAwarded);
  const attemptedPoints = categories
    .filter((category) => category.itemCount > 0)
    .reduce((sum, category) => sum + category.points, 0);
  const efficiencyAttempted =
    EFFICIENCY.scored && categories.every((category) => category.itemCount > 0)
      ? EFFICIENCY.points
      : 0;
  const implementedPoints = categories
    .filter((category) => category.implemented)
    .reduce((sum, category) => sum + category.points, 0);

  const normalized = total / TOTAL_POINTS;
  const failedCategories = categories.filter(
    (category) => category.itemCount > 0 && !category.passed,
  );
  const anyRan = items.length > 0;
  const passedArithmetically =
    anyRan &&
    meetsThreshold(normalized, PASS_THRESHOLD.overall) &&
    failedCategories.length === 0;
  /**
   * What a full run has to cover.
   *
   * The efficiency modifier is not a category, so no item can ever attempt its five points. While
   * the modifier is unscored, measuring completeness against all 75 would make every run
   * incomplete for ever, including a run of the whole suite, which would leave the suite unable
   * to produce the verdict it exists to produce. It is included in the target only once it is
   * actually scored.
   */
  const completenessTarget = EFFICIENCY.scored ? TOTAL_POINTS : CAPABILITY_POINTS;
  const incomplete = attemptedPoints + efficiencyAttempted < completenessTarget;

  /**
   * A substituted judge invalidates the judged share of the number.
   *
   * Checked before coverage, because the two are different kinds of defect: an incomplete run has
   * no score yet, while a run under a different judge has an answer to a different question. The
   * second is the more dangerous thing to quote, so it takes precedence.
   */
  const judged = items.some((item) => item.judgeGraded);
  const judgePinned = input.judgePinned ?? true;

  // A judged item with no judge on record would produce a number whose provenance is unknown.
  // That is a wiring bug, not a finding, so it is a hard failure rather than a quiet default.
  if (judged && (input.judge === null || input.judge === undefined)) {
    throw new Error(
      "a judged item ran but no judge was recorded, so the source of that score would be unknown",
    );
  }

  const substitutedJudge = judged && !judgePinned;

  const verdict: Verdict = substitutedJudge
    ? "not-valid"
    : incomplete
      ? "incomplete"
      : passedArithmetically
        ? "pass"
        : "fail";

  const report: RunReport = {
    suite: ESAC_SUITE,
    implementationVersion: ESAC_IMPLEMENTATION_VERSION,
    versionTag: ESAC_VERSION_TAG,
    fullName: ESAC_AG_FULL_NAME,
    status: ESAC_STATUS,
    datasetSeedFingerprint: input.datasetSeedFingerprint,
    split: input.split ?? "public",
    model: input.model,
    judge: input.judge ?? null,
    judgePinned,
    judgeGradedPoints: JUDGE_GRADED_POINTS,
    items,
    categories,
    total,
    totalPossible: TOTAL_POINTS,
    normalized,
    passed: passedArithmetically,
    verdict,
    coverage: { implementedPoints, attemptedPoints: attemptedPoints + efficiencyAttempted },
    efficiency: { points: EFFICIENCY.points, awarded: efficiencyAwarded, scored: EFFICIENCY.scored },
    notes: [],
    durationMs: input.durationMs,
  };

  return { ...report, notes: reportNotes(report) };
}

/**
 * The sentences a reader needs in order not to misuse the number.
 *
 * Written as data rather than interpolated into the renderer so the CLI, the JSON report, and
 * the tests all see the same text.
 */
export function reportNotes(report: RunReport): string[] {
  const notes: string[] = [];
  const failed = report.categories.filter((category) => category.itemCount > 0 && !category.passed);
  const nameOf = (id: CategoryId): string =>
    report.categories.find((category) => category.id === id)?.name ?? id;

  const missing = report.categories.filter((category) => !category.implemented);
  if (missing.length > 0) {
    const implemented = report.categories.length - missing.length;
    notes.push(
      `This run could attempt ${implemented} of ${report.categories.length} categories, so at most ${report.coverage.implementedPoints} of ${report.totalPossible} points can be earned. ` +
        `Not attempted: ${missing.map((category) => category.name).join(", ")}.`,
    );
  }

  if (report.verdict === "incomplete") {
    notes.push(
      `Partial run: only ${report.coverage.attemptedPoints} of ${report.totalPossible} points were attempted, ` +
        "so this is not a comparable full-suite score. A category with no items in the selection is " +
        "reported as not attempted rather than as a failure.",
    );
  }

  const judgedItems = report.items.filter((item) => item.judgeGraded);
  if (judgedItems.length > 0) {
    notes.push(
      `${judgedItems.length} of ${report.items.length} items were graded by a judge, which is ${report.judgeGradedPoints} of the ${report.totalPossible} points. ` +
        `Each ran the model ${REPLICATION.judgeModelRuns} times with ${REPLICATION.judgeJudgmentsPerResponse} judgments per response, and the observations were averaged.`,
    );
  }

  if (report.verdict === "not-valid") {
    notes.push(
      `Not a valid ESAC-AG result. The judge was "${report.judge}", not the judge pinned for this release (${PINNED_JUDGE}). ` +
        `That judge decides ${report.judgeGradedPoints} of the ${report.totalPossible} points, so no verdict is reported either way. ` +
        "The deterministic categories were measured normally and are reported above.",
    );
  }

  const overBudget = report.items.filter((item) => item.endedBecause === "budget").length;
  if (overBudget > 0) {
    notes.push(
      `${overBudget} task${overBudget === 1 ? "" : "s"} reached the step budget without finishing, which scores zero for that task.`,
    );
  }

  const modelFailures = report.items.filter((item) => item.endedBecause === "model-failure").length;
  if (modelFailures > 0) {
    notes.push(
      `${modelFailures} task${modelFailures === 1 ? "" : "s"} ended in a model failure rather than an answer.`,
    );
  }

  if (failed.length > 0) {
    notes.push(
      `Below the ${(PASS_THRESHOLD.perCategory * 100).toFixed(0)} percent category threshold: ${failed.map((category) => nameOf(category.id)).join(", ")}.`,
    );
  } else if (report.verdict === "fail") {
    notes.push(`The overall score is below the ${(PASS_THRESHOLD.overall * 100).toFixed(0)} percent threshold.`);
  }

  if (report.efficiency.scored) {
    notes.push(
      `The efficiency modifier is scored for successful tasks from authored action and token envelopes, weighted ${EFFICIENCY.actionWeight} to ${EFFICIENCY.tokenWeight}. Failed or incomplete tasks earn no efficiency points.`,
    );
  }

  if (report.split === "public") {
    notes.push("This was a public-pool run. Official comparative claims should cite a held-out run.");
  }

  notes.push(
    `${TOTAL_ITEMS} items is a small sample. The total is a directional signal; the per-category breakdown is where the diagnostic value is.`,
  );
  return notes;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The one-word status shown next to a score, in both renderers.
 *
 * `not-valid` has a hyphen because it is a key in a union type; the label does not, because it is
 * a sentence fragment a reader sees. Deriving the label with `toUpperCase()` printed the hyphen,
 * which is how a substituted-judge run came out as `NOT-VALID` in one renderer and `NOT VALID` in
 * the other.
 */
const VERDICT_LABEL: Readonly<Record<Verdict, string>> = {
  pass: "PASS",
  fail: "FAIL",
  incomplete: "INCOMPLETE",
  "not-valid": "NOT VALID",
};

/** A fixed-width fraction bar. Clamped, because a renderer should never be what fails. */
function bar(fraction: number, width = 24): string {
  const capped = Math.min(1, Math.max(0, fraction));
  const filled = Math.round(capped * width);
  return `[${"#".repeat(filled)}${".".repeat(width - filled)}]`;
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

export interface RenderOptions {
  readonly verbose?: boolean;
}

export function renderReport(report: RunReport, options: RenderOptions = {}): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(`=== ${report.suite} (implementation ${report.implementationVersion}) ===`);
  lines.push(report.fullName);
  lines.push(`model:  ${report.model}`);
  lines.push(`status: ${report.status}`);
  lines.push(`seed:   ${report.datasetSeedFingerprint}`);
  lines.push("");

    lines.push("SECTION SCORES - " + report.split + " pool");
  for (const category of report.categories) {
    const label = category.name.padEnd(32);
    if (!category.implemented) {
      lines.push(`  ${label} ${category.points.toFixed(2).padStart(6)}/${category.points}   not implemented`);
      continue;
    }
    const percent = (category.normalized * 100).toFixed(1);
    const mark = category.passed ? " " : "!";
    lines.push(
      `  ${label} ${category.awarded.toFixed(2).padStart(6)}/${category.points}${percent.padStart(8)}%  ${bar(category.normalized)}${mark}`,
    );
  }
  lines.push("");
  lines.push("  ! = below the 60% category threshold");
  lines.push("");

  lines.push("OVERALL");
  const overallPercent = (report.normalized * 100).toFixed(1);
  lines.push(
    `  ${report.total.toFixed(2)} / ${report.totalPossible}  (${overallPercent}%)  ${VERDICT_LABEL[report.verdict]}`,
  );
  if (report.verdict === "not-valid") {
    lines.push("  The judge was not the judge pinned for this release, so there is no verdict on the model.");
  }
  lines.push(
    `  coverage: ${report.coverage.attemptedPoints} of ${report.totalPossible} points attempted, ${report.coverage.implementedPoints} of ${report.totalPossible} implemented`,
  );
  lines.push(`  duration: ${(report.durationMs / 1000).toFixed(1)}s`);
  lines.push("");

  if (options.verbose) {
    lines.push("ITEMS");
    for (const item of report.items) {
      lines.push(
        `  ${item.itemId.padEnd(30)} ${item.awarded.toFixed(2).padStart(5)}/${item.points}  ${(item.fraction * 100).toFixed(0).padStart(3)}%  ${item.steps} step${item.steps === 1 ? "" : "s"}  ${item.endedBecause}`,
      );
      for (const check of item.checks) {
        lines.push(`      ${check.id}: ${check.detail}`);
      }
    }
    lines.push("");
  }

  lines.push("NOTES");
  for (const note of report.notes) for (const line of wrap(note, 76)) lines.push(`  ${line}`);
  lines.push("");

  return lines.join("\n");
}

/** Wrap a note to `width` columns, hanging-indenting continuations under a bullet. */
function wrapNote(text: string, width: number): string[] {
  const out: string[] = [];
  let current = "";

  for (const word of text.split(/\s+/).filter((word) => word.length > 0)) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width - 4) {
      current = `${current} ${word}`;
    } else {
      out.push(current);
      current = word;
    }
  }
  if (current.length > 0) out.push(current);

  return out.map((line, index) => (index === 0 ? `  - ${line}` : `    ${line}`));
}

/**
 * Auto-mode presentation: the headline first, the sections beneath it, and the notes that
 * qualify the number at the end.
 *
 * Deliberately the same layout as ESAC-GI's, because a reader who has run one suite should be
 * able to read the other without learning a second report. ASCII only, so it survives a terminal
 * with a hostile code page.
 */
export function renderFinalReport(report: RunReport): string {
  const lines: string[] = [];
  const rule = "=".repeat(72);
  const verdict = VERDICT_LABEL[report.verdict];

  lines.push("");
  lines.push(rule);
  lines.push(`  ${report.fullName}`);
  lines.push(
    `  ${report.versionTag}   ${report.split} pool   model: ${report.model}` +
      (report.judge ? `   judge: ${report.judge}` : ""),
  );
  lines.push(rule);
  lines.push("");

  const total = `${report.total.toFixed(2)} / ${report.totalPossible}`;
  const percent = `${(report.normalized * 100).toFixed(1)}%`;
  lines.push(`  OVERALL SCORE   ${total.padEnd(16)} ${percent.padStart(7)}     ${verdict}`);
  lines.push("");

  lines.push("  SECTION SCORES");
  for (const category of report.categories) {
    const name = category.name.padEnd(33).slice(0, 33);
    if (category.itemCount === 0) {
      lines.push(`    ${name} ${"not run".padStart(22)}`);
      continue;
    }
    const flag = category.passed ? " " : "!";
    const raw = `${category.awarded.toFixed(2)} / ${category.points}`.padStart(14);
    const categoryPercent = `${(category.normalized * 100).toFixed(1)}%`.padStart(7);
    lines.push(`  ${flag} ${name} ${raw} ${categoryPercent}  ${bar(category.normalized)}`);
  }
  lines.push("");
  if (report.categories.some((category) => category.itemCount > 0 && !category.passed)) {
    lines.push(
      `  ! = below the ${(PASS_THRESHOLD.perCategory * 100).toFixed(0)}% category threshold`,
      "",
    );
  }

  const notes = reportNotes(report);
  if (notes.length > 0) {
    lines.push("  NOTES");
    for (const note of notes) lines.push(...wrapNote(note, 76));
    lines.push("");
  }

  const modelFailures = report.items.filter((item) => item.endedBecause === "model-failure").length;
  const tokens = report.items.reduce(
    (sum, item) => sum + item.promptTokens + item.completionTokens,
    0,
  );
  lines.push(
    `  ${(report.durationMs / 1000).toFixed(1)}s   ${report.items.length} items   ` +
      `${tokens} tokens   model failures: ${modelFailures}   ` +
      `efficiency: ${report.efficiency.awarded}/${report.efficiency.points}`,
  );
  lines.push(`  seed fingerprint: ${report.datasetSeedFingerprint}`);
  lines.push("");

  return lines.join("\n");
}

/** The machine-readable form. Same content, no rendering decisions. */
export function toJson(report: RunReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
