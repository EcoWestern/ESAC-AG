/**
 * Deterministic grading.
 *
 * Two graders, one for each shape an agentic task can be graded in without asking a judge:
 * whether the model did the right thing first, and whether the environment ended in the right
 * state.
 *
 * Both are deliberately strict about what counts as correct and deliberately explicit about
 * what they ignore, because a grader whose tolerance is undocumented is a grader whose score
 * cannot be audited.
 */

import type {
  Check,
  CheckResult,
  EnvSnapshot,
  GradeContext,
  GraderResult,
  ToolCall,
} from "./types.ts";

/**
 * Normalise a value for comparison.
 *
 * Case, surrounding whitespace, and internal runs of whitespace are ignored, so
 * `"Customer Request"` and `"customer  request"` do not differ by punctuation-shaped accident.
 * A numeric-looking string is compared as a number, so `"42.50"` and `42.5` agree: an endpoint
 * that types a quantity as text has not chosen the wrong target.
 *
 * Nothing else is normalised. An identifier that is simply wrong stays wrong.
 */
function normaliseValue(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return String(Number(trimmed));
    return trimmed.toLowerCase().replace(/\s+/g, " ");
  }
  return JSON.stringify(value);
}

/** The first tool call of the run, or null when the model made none. */
export function firstCall(context: GradeContext): ToolCall | null {
  const step = context.transcript.steps[0];
  if (!step) return null;
  return step.calls[0] ?? null;
}

export function allCalls(context: GradeContext): ToolCall[] {
  return context.transcript.steps.flatMap((step) => [...step.calls]);
}

/**
 * Exact match on the first tool call.
 *
 * The tool must be right and every parameter the task names must be right. Extra parameters are
 * ignored on purpose: an endpoint that echoes a default, or a model that restates an identifier
 * it was given, has not chosen the wrong operation, and the fault this grader is meant to catch
 * is the wrong operation with the wrong target.
 */
export function gradeToolCallExact(
  tool: string,
  expectedArgs: Readonly<Record<string, unknown>>,
  context: GradeContext,
): GraderResult {
  const call = firstCall(context);
  if (!call) return { fraction: 0, detail: "no tool call was made" };

  if (call.name !== tool) {
    return { fraction: 0, detail: `the first call was "${call.name}", expected "${tool}"` };
  }

  const problems: string[] = [];
  for (const [key, expected] of Object.entries(expectedArgs)) {
    const actual = call.args[key];
    if (actual === undefined) {
      problems.push(`"${key}" was missing`);
      continue;
    }
    if (normaliseValue(actual) !== normaliseValue(expected)) {
      problems.push(`"${key}" was ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  }

  if (problems.length > 0) {
    return { fraction: 0, detail: `the right tool with the wrong parameters: ${problems.join("; ")}` };
  }
  return { fraction: 1, detail: `called ${tool} with the expected parameters` };
}

/** Flatten a snapshot into comparable resources, so partial credit is per resource. */
function flatten(snapshot: EnvSnapshot): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, content] of Object.entries(snapshot.files)) out.set(`files/${path}`, content);
  for (const [key, value] of Object.entries(snapshot.api)) {
    out.set(`api/${key}`, JSON.stringify(value));
  }
  return out;
}

/**
 * Compare the final environment against the goal state, with partial credit by resource.
 *
 * An empty expectation is a full score rather than a free pass: a task that expects no change is
 * graded by its other checks, and returning zero there would punish a correctly unmodified
 * environment.
 */
export function gradeStateDiff(expected: EnvSnapshot, context: GradeContext): GraderResult {
  const wanted = flatten(expected);
  if (wanted.size === 0) return { fraction: 1, detail: "no state change was required" };

  const actual = flatten(context.finalState);
  const matched: string[] = [];
  const wrong: string[] = [];
  for (const [resource, value] of wanted) {
    if (actual.get(resource) === value) matched.push(resource);
    else wrong.push(resource);
  }

  const fraction = matched.length / wanted.size;
  if (wrong.length === 0) {
    return { fraction: 1, detail: `all ${wanted.size} resources match the goal state` };
  }
  const shown = wrong.slice(0, 3).join(", ");
  const rest = wrong.length > 3 ? `, +${wrong.length - 3} more` : "";
  return {
    fraction,
    detail: `${matched.length} of ${wanted.size} resources match; differs on ${shown}${rest}`,
  };
}

/** Apply one check. */
export function gradeCheck(check: Check, context: GradeContext): CheckResult {
  const grader = check.grader;
  let result: GraderResult;

  switch (grader.type) {
    case "toolcall-exact":
      result = gradeToolCallExact(grader.tool, grader.args, context);
      break;
    case "state-diff":
      result = gradeStateDiff(grader.expected, context);
      break;
    default: {
      // Exhaustiveness: a new grader type has to be handled rather than silently scoring zero.
      const unreachable: never = grader;
      throw new Error(`unhandled grader ${JSON.stringify(unreachable)}`);
    }
  }

  return { id: check.id, fraction: result.fraction, detail: result.detail };
}

/**
 * Weighted fraction across an item's checks.
 *
 * Weights are normalised here rather than pre-normalised by the author, so a check's weight can
 * be read as its share of the item without arithmetic.
 */
export function gradeChecks(checks: readonly Check[], context: GradeContext): {
  readonly fraction: number;
  readonly results: readonly CheckResult[];
} {
  if (checks.length === 0) return { fraction: 0, results: [] };
  const total = checks.reduce((sum, check) => sum + check.weight, 0);
  if (total <= 0) throw new Error("check weights must sum to more than zero");

  const results = checks.map((check) => gradeCheck(check, context));
  const fraction = checks.reduce(
    (sum, check, index) => sum + check.weight * (results[index]?.fraction ?? 0),
    0,
  ) / total;

  return { fraction, results };
}
