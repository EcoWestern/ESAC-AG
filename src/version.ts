/**
 * Version identity for ESAC-AG.
 *
 * Two different things are called a version in this program, and conflating them would be a
 * mistake. This file declares the **implementation** version, which tracks the code, and the
 * **benchmark** version tag, which is a promise that a score means the same thing twice.
 *
 * The benchmark is ESAC-AG v1.0: all seven categories have items and the suite can produce a
 * score. The rules in the ESAC specification apply from here — minor releases rotate content,
 * major releases change what is measured, and a score is comparable within a major version and
 * nowhere else (amendment 001 §9).
 */

/** Suite identifier, as it appears in the specification. */
export const ESAC_SUITE = "ESAC-AG";

/** Suite name. */
export const ESAC_AG_NAME = "Agentic Work and Capability";

/** Full name, following the program's naming pattern. */
export const ESAC_AG_FULL_NAME =
  "EcoWestern Short and Cheap Agentic Work and Capability Benchmark";

/** Implementation version. Tracks the code, not the measurement. */
export const ESAC_IMPLEMENTATION_VERSION = "1.0.2";

/** One line on what this build is, printed wherever a version is. */
export const ESAC_STATUS =
  "released: all seven categories implemented, efficiency modifier scored";

/** What a report carries in the version tag field. Never a comparability claim. */
export const ESAC_VERSION_TAG = "ESAC-AG v1.0";

/** Full name with the version tag, for the top of a report. */
export const ESAC_VERSION_LINE = `${ESAC_AG_FULL_NAME}, implementation ${ESAC_IMPLEMENTATION_VERSION}`;

/**
 * Dataset seeds. Instance identity derives from `hash(datasetSeed + ":" + itemId)`, never from
 * the run, so every model in a comparison sees byte-identical instances.
 *
 * The public seed is disclosed with the repository. The held-out seed is evaluator-controlled
 * and must never be committed, exactly as in ESAC-GI.
 */
export const PUBLIC_DATASET_SEED = "esac-ag-v1.0-public";

/** Environment variable carrying the evaluator-controlled held-out seed. */
export const HELD_OUT_DATASET_SEED_ENV = "ESAC_AG_HELD_OUT_SEED";

/**
 * Canary string. Embedded in every public raw item file so that leaked training data can be
 * detected. See the specification, "Contamination resistance".
 */
export const CANARY = "ESAC-CANARY-AG-2c6f81d4b7a30e95-v1.0";

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
  /** Judge output is a small JSON object: criterion ids mapped to integers. */
  judgeTokens: 512,
} as const;

/**
 * The pinned judge.
 *
 * Open-weight and self-hostable, so the judge cannot be withdrawn or silently changed by a
 * vendor, and pinned per release so a rubric score cannot drift under the suite. The same model
 * ESAC-GI pins, because two suites judging the same way is one standard rather than two.
 */
export const PINNED_JUDGE = "xiaomi/mimo-v2.6-pro";

/** Why this model, for whoever has to review the choice. */
export const PINNED_JUDGE_RATIONALE =
  "chosen for general capability on ordinal judgement and for being reachable as a hosted open-weight model, so a run is reproducible without hosting anything. The pin is a release decision, not a statement that no better judge exists.";

/**
 * Whether a model id names the pinned judge.
 *
 * Identity is the final path segment with any tag removed, so `xiaomi/mimo-v2.6-pro`, a bare
 * `mimo-v2.6-pro`, and a local tag like `mimo-v2.6-pro:latest` are all the pinned model. A
 * different version tag is not: `mimo-v2.6` and `mimo-v2.7` are different judges, and a run
 * under one of them is not the same measurement.
 */
export function isPinnedJudge(model: string): boolean {
  const identity = (value: string): string => {
    const segment = value.trim().toLowerCase().split("/").pop() ?? "";
    return segment.split(":")[0] ?? "";
  };
  return identity(model) === identity(PINNED_JUDGE);
}

/**
 * Where the judge is reached by default, and the variable its key is read from.
 *
 * An aggregator, because it serves the pinned open-weight model without the suite depending on
 * any one provider's API shape. Overridden with `--judge <baseUrl>|<model>|<keyEnvVar>`.
 */
export const DEFAULT_JUDGE_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_JUDGE_KEY_ENV = "OPENROUTER_API_KEY";
export const DEFAULT_JUDGE_SPEC = `${DEFAULT_JUDGE_BASE_URL}|${PINNED_JUDGE}|${DEFAULT_JUDGE_KEY_ENV}`;

/**
 * Execution limits for generated code.
 *
 * These are part of the measurement, not configuration. A task that only passes with an
 * unlimited heap or an unbounded clock is not measuring the same thing as the rest of the suite,
 * and a per-run override would make two runs incomparable, so they are fixed here rather than
 * being flags.
 *
 * The wall-clock limit is generous for tasks this small: a script that needs five seconds is
 * looping, not computing.
 */
export const EXECUTION = {
  /** Wall-clock limit for one run of a generated script. */
  timeoutMs: 5000,
  /** Heap cap, passed to the child as --max-old-space-size. */
  memoryMb: 256,
  /** Cap on each captured stream. */
  maxOutputBytes: 256 * 1024,
  /** Caps on what a script may leave behind, so a runaway cannot fill the disk. */
  maxFiles: 200,
  maxFileBytes: 512 * 1024,
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
 */
export const EFFICIENCY = {
  points: 5,
  actionWeight: 3.5,
  tokenWeight: 1.5,
  localScale: { min: 1, max: 6 },
  /**
   * Whether the modifier counts towards what a full run must cover.
   *
   * Read by the scorer, which has to know whether the modifier counts towards what a full run
   * must cover: five points that no item can attempt would otherwise leave every run, including
   * a run of the entire suite, permanently incomplete.
   */
  scored: true,
} as const;

/**
 * Replication. Deterministic items run once at temperature 0. Judge-graded items run twice and
 * are judged twice, so model variance and judge variance stay separable.
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
