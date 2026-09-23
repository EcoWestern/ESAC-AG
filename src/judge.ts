/**
 * Judge prompt construction, response parsing, and rubric scoring.
 *
 * The same shape as ESAC-GI's, deliberately: two suites that judge the same way can be argued
 * about with one set of rules, and a second, subtly different protocol would be a second
 * standard.
 *
 * Three constraints from the specification shape this file:
 *
 *   - the judge must be open-weight, self-hostable, and pinned per release. A rubric score that
 *     drifts because the judge model was updated upstream is a reproducibility failure, so the
 *     rubric carries a version id and the judge's identity is recorded in every run;
 *   - judge-graded items run the model twice and each response is judged twice, and the four
 *     observations are averaged. Nothing here assumes a single observation;
 *   - a judge that returns prose instead of parseable scores is an infrastructure failure,
 *     retried and never scored, rather than a silent zero. The difference matters: one is a
 *     broken run, the other is a finding about the model, and conflating them flatters nobody.
 *
 * Parsing is tolerant about formatting and strict about content, because small open-weight
 * models are inconsistent about fences and nesting, and a formatting quirk should not throw away
 * an otherwise usable judgment.
 */

import type { JudgeResponse, Rubric, RubricCriterion } from "./types.ts";

/** The scale every criterion is scored on, fixed so two rubrics are comparable. */
export const JUDGE_SCORE_MAX = 4;

/** Render the judge prompt. Deterministic, and free of anything run-specific. */
export function renderJudgePrompt(
  rubric: Rubric,
  taskPrompt: string,
  response: string,
  facts: readonly string[] = [],
): string {
  const criteria = rubric.criteria
    .map((criterion, index) => {
      const levels = (criterion.levels ?? [])
        .map((level) => `    - ${level.score} (${level.label}): ${level.description}`)
        .join("\n");
      return (
        `${index + 1}. id: ${criterion.id} (weight ${criterion.weight}, scored 0-${JUDGE_SCORE_MAX})\n` +
        `   ${criterion.description}\n` +
        (levels ? `${levels}\n` : "")
      );
    })
    .join("\n");

  const factsBlock =
    facts.length === 0
      ? ""
      : `## What the run actually did\n\n` +
        `These lines are recorded by the harness, not written by the model, and they are the only\n` +
        `trustworthy account of what happened to the environment:\n\n` +
        facts.map((fact) => `- ${fact}`).join("\n") +
        `\n\n`;

  return (
    `You are scoring a single response against a fixed rubric. You are not the author of the ` +
    `response and you must not rewrite it.\n\n` +
    `## What the task was asking for\n\n${rubric.context}\n\n` +
    `## The task given to the model\n\n${taskPrompt}\n\n` +
    `## The model's response\n\n<<<RESPONSE\n${response}\nRESPONSE>>>\n\n` +
    factsBlock +
    `## Rubric\n\n${criteria}\n` +
    `## Output format\n\n` +
    `Return only a JSON object mapping each criterion id to an integer score from 0 to ` +
    `${JUDGE_SCORE_MAX}. Use the exact criterion ids given above. Example shape:\n` +
    `{"${rubric.criteria[0]?.id ?? "criterion"}": 3}\n\n` +
    `Do not include any other text, explanation, or markdown fence.`
  );
}

/** Parse the judge's output, accepting a bare object, a fenced block, or an object in a sentence. */
export function parseJudgeResponse(raw: string, rubric: Rubric): JudgeResponse | null {
  const text = raw.trim();
  const candidates: string[] = [text];

  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence?.[1] !== undefined) candidates.push(fence[1].trim());

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));

  for (const candidate of candidates) {
    const parsed = tryParseObject(candidate);
    if (parsed === null) continue;
    const scores = coerceScores(parsed, rubric);
    if (scores !== null) return { scores, raw };
  }

  return null;
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Every criterion must be answered, or the judgment is unusable. */
function coerceScores(
  parsed: Readonly<Record<string, unknown>>,
  rubric: Rubric,
): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const criterion of rubric.criteria) {
    const found = findScore(parsed, criterion);
    if (found === null) return null;
    out[criterion.id] = clamp(found, 0, JUDGE_SCORE_MAX);
  }
  return out;
}

/** Tolerate case, separators, and the common `{id: {score: n}}` nesting. */
function findScore(
  parsed: Readonly<Record<string, unknown>>,
  criterion: RubricCriterion,
): number | null {
  const keys = Object.keys(parsed);
  const match = keys.find((key) => normaliseKey(key) === normaliseKey(criterion.id));

  if (match !== undefined) {
    const direct = toNumber(parsed[match]);
    if (direct !== null) return direct;

    const nested = parsed[match];
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      const inner = nested as Record<string, unknown>;
      const found = toNumber(inner["score"] ?? inner["value"] ?? inner["rating"]);
      if (found !== null) return found;
    }
  }

  // A single fuzzy match is accepted; two would be a guess about which criterion was meant.
  const target = normaliseKey(criterion.id);
  const fuzzy = keys.filter((key) => normaliseKey(key).includes(target));
  if (fuzzy.length === 1) return toNumber(parsed[fuzzy[0]!]);

  return null;
}

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Normalise criterion scores to a fraction in [0, 1].
 *
 * Weights are normalised here rather than by the judge, so a rubric can be edited without asking
 * the judge to reason about relative importance.
 */
export function scoreRubric(scores: Readonly<Record<string, number>>, rubric: Rubric): number {
  const totalWeight = rubric.criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  if (totalWeight <= 0) throw new Error(`rubric ${rubric.id} has no positive weights`);

  let awarded = 0;
  for (const criterion of rubric.criteria) {
    const raw = scores[criterion.id];
    if (raw === undefined) throw new Error(`rubric ${rubric.id}: no score for ${criterion.id}`);
    awarded += (clamp(raw, 0, JUDGE_SCORE_MAX) / JUDGE_SCORE_MAX) * criterion.weight;
  }

  return clamp(awarded / totalWeight, 0, 1);
}

/**
 * Mean of several observations.
 *
 * Averaging is the right combiner because the criteria are on an ordinal 0-4 scale rather than
 * pass or fail. Every criterion here is an ordinal judgement, and taking the mode of four
 * ordinal observations would throw away the distance between them.
 */
export function meanFraction(fractions: readonly number[]): number {
  if (fractions.length === 0) return 0;
  return fractions.reduce((sum, value) => sum + value, 0) / fractions.length;
}
