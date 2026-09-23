/**
 * Version identity for ESAC-AG.
 *
 * Two different things are called a version in this program, and conflating them would be a
 * mistake. This file declares the **implementation** version, which tracks the code. No
 * **benchmark** version exists yet: a benchmark version is a promise that a score means the
 * same thing twice, and it cannot be made while six of the seven categories are empty.
 *
 * When the suite can produce a score, the rules in the ESAC specification apply: minor
 * releases rotate content, major releases change what is measured, and a score is comparable
 * within a major version and nowhere else.
 */

/** Suite identifier, as it appears in the specification. */
export const ESAC_SUITE = "ESAC-AG";

/** Suite name. */
export const ESAC_AG_NAME = "Agentic Work and Capability";

/** Full name, following the program's naming pattern. */
export const ESAC_AG_FULL_NAME =
  "EcoWestern Short and Cheap Agentic Work and Capability Benchmark";

/**
 * Implementation version. Tracks the code, not the measurement.
 *
 * It stays in the zero range deliberately. There is no honest 1.0 of a benchmark that cannot
 * produce a score yet.
 */
export const ESAC_IMPLEMENTATION_VERSION = "0.1.0";

/** One line on what this build is, printed wherever a version is. */
export const ESAC_STATUS = "unreleased: one of seven categories implemented";

/** What a report carries in the version tag field. Never a comparability claim. */
export const ESAC_VERSION_TAG = "ESAC-AG (unreleased, not comparable)";

/** Full name with the version tag, for the top of a report. */
export const ESAC_VERSION_LINE = `${ESAC_AG_FULL_NAME}, implementation ${ESAC_IMPLEMENTATION_VERSION}`;

/**
 * Dataset seeds. Instance identity derives from `hash(datasetSeed + ":" + itemId)`, never from
 * the run, so every model in a comparison sees byte-identical instances.
 *
 * The public seed is disclosed with the repository. The held-out seed is evaluator-controlled
 * and must never be committed, exactly as in ESAC-GI.
 */
export const PUBLIC_DATASET_SEED = "esac-ag-v0.1-public";

/** Environment variable that carries the held-out dataset seed. */
export const HELD_OUT_DATASET_SEED_ENV = "ESAC_AG_HELD_OUT_SEED";

/**
 * Canary string. Embedded in every public raw item file so that leaked training data can be
 * detected. See the specification, "Contamination resistance".
 */
export const CANARY = "ESAC-CANARY-AG-2c6f81d4b7a30e95-v0.1";

/**
 * The cap on tool calls for one task.
 *
 * Constitution §6 fixes the range and says why: a tight budget is what keeps a small
 * environment hard, and what stops a single item from quietly becoming a long-running loop.
 * Each task declares its own value inside this range.
 */
export const STEP_BUDGET = { min: 10, max: 15 } as const;

/**
 * Decoding parameters, part of the benchmark definition rather than per-run configuration.
 *
 * Temperature 0, because the point of the suite is that the environment is deterministic and
 * the only variable left should be the model.
 */
export const DECODING = {
  temperature: 0,
  topP: 1,
} as const;

/** Output limits. Tool-call JSON is small; a response that needs more than this is a failure. */
export const OUTPUT_LIMITS = {
  modelTokens: 4096,
} as const;

/**
 * Passing criteria, from the specification: every category and the whole suite, because a
 * strong average must not rescue a hole.
 */
export const PASS_THRESHOLD = {
  perCategory: 0.6,
  overall: 0.6,
} as const;

/**
 * The efficiency modifier, from amendment 001 §1.
 *
 * It is separate from capability, only a successful task can earn it, and action efficiency is
 * weighted more heavily than token efficiency. The per-task scale is authored in advance on an
 * internal 1 to 6 range and normalised into these 5 points.
 *
 * Declared here so the numbers live in one place, and not yet applied: scoring the modifier
 * needs each task's authored envelope, which arrives with the categories that use it.
 */
export const EFFICIENCY = {
  points: 5,
  actionWeight: 3.5,
  tokenWeight: 1.5,
  localScale: { min: 1, max: 6 },
} as const;

/**
 * Replication. Deterministic items run once at temperature 0. Judge-graded items run twice and
 * are judged twice, so model variance and judge variance stay separable. The judge-graded
 * category here is not implemented yet, so only the first half is in use.
 */
export const REPLICATION = {
  deterministicModelRuns: 1,
  judgeModelRuns: 2,
  judgeJudgmentsPerResponse: 2,
} as const;

/**
 * Infrastructure retry policy. Infrastructure failures are retried and never scored, so an
 * outage can never be reported as a low score.
 */
export const INFRA_RETRY = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 8000,
} as const;
