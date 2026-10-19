#!/usr/bin/env node
/**
 * ESAC-AG command-line interface.
 *
 * Usage:
 *   esac list                                  show the item bank and point allocation
 *   esac inspect <itemId> [--seed <s>]         render one generated instance
 *   esac run [options]                         run the suite
 *   esac selftest                              verify the harness end to end, offline
 *   esac version                               print the implementation version and canary
 *
 * run options:
 *   --model <spec>     "oracle" (harness self-test) or "<baseUrl>|<model>|<apiKeyEnvVar>"
 *   --items <list>     comma-separated item ids or category ids
 *   --seed <s>         dataset seed (default: the disclosed public seed)
 *   --max-tokens <n>   output cap for the model under test
 *   --json <path>      write the full report as JSON
 *   --verbose          include per-check detail in the report
 *   --quiet            suppress the per-item progress tally
 *
 * Exit codes: 0 a pass, 1 anything else, 2 an infrastructure failure. There is no separate code
 * for INCOMPLETE: it is not a kind of failure, it is the absence of a score, and the report says
 * so in words.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  CATEGORIES,
  ITEM_COUNTS,
  JUDGE_GRADED_POINTS,
  TOTAL_ITEMS,
  TOTAL_POINTS,
  itemPointsFor,
  validateDistribution,
} from "./categories.ts";
import { ALL_ITEMS, instantiateAll, seedFingerprint, validateBank } from "./registry.ts";
import { gradeChecks, gradeItem, type JudgeOutcome } from "./graders.ts";
import { runJudgedTask, runTask } from "./runner.ts";
import { scoreRun, renderReport, toJson, type ItemOutcome } from "./score.ts";
import { createHttpAgent, createOracleAgent, createOracleJudge, type OracleAgent } from "./adapters.ts";
import { describeSandbox } from "./env/sandbox.ts";
import { loadDotEnv } from "./env.ts";
import { generateSeed, missingSeedMessage, readSeedFile, resolveHeldOutSeed, writeSeedFile } from "./seedfile.ts";
import {
  CANARY,
  DECODING,
  DEFAULT_JUDGE_KEY_ENV,
  DEFAULT_JUDGE_SPEC,
  ESAC_IMPLEMENTATION_VERSION,
  ESAC_STATUS,
  ESAC_VERSION_TAG,
  OUTPUT_LIMITS,
  PINNED_JUDGE,
  PINNED_JUDGE_RATIONALE,
  PUBLIC_DATASET_SEED,
  HELD_OUT_DATASET_SEED_ENV,
  REPLICATION,
  STEP_BUDGET,
  isPinnedJudge,
} from "./version.ts";
import { InfrastructureError } from "./types.ts";
import type { AgentAdapter, EnvSnapshot, Instance, JudgeAdapter, Transcript } from "./types.ts";

interface Args {
  readonly command: string;
  readonly flags: ReadonlyMap<string, string>;
  readonly positional: readonly string[];
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  let command = "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(arg.slice(2), next);
          i++;
        } else {
          flags.set(arg.slice(2), "true");
        }
      }
    } else if (command === "") {
      command = arg;
    } else {
      positional.push(arg);
    }
  }

  return { command, flags, positional };
}

function fail(message: string): never {
  console.error(`\n  error: ${message}\n`);
  process.exit(1);
}

function resolvePool(args: Args): { readonly split: "public" | "heldout"; readonly seed: string } {
  const raw = args.flags.get("split") ?? "public";
  if (raw !== "public" && raw !== "heldout") fail(`--split must be public or heldout; "both" is not a run mode`);
  if (raw === "public") return { split: raw, seed: args.flags.get("seed") ?? PUBLIC_DATASET_SEED };
  const seed = resolveHeldOutSeed({
    explicit: args.flags.get("seed"),
    environment: process.env[HELD_OUT_DATASET_SEED_ENV],
  });
  if (!seed) fail(missingSeedMessage());
  return { split: raw, seed };
}

function cmdSeed(args: Args): void {
  const action = args.positional[0] ?? "new";
  if (action === "new") {
    const seed = generateSeed();
    writeSeedFile(seed, { force: args.flags.has("force"), path: args.flags.get("out") });
    console.log(`held-out seed written to ${args.flags.get("out") ?? ".heldout/seed"}`);
    return;
  }
  if (action === "show") {
    const seed = readSeedFile(args.flags.get("out"));
    if (!seed) fail("no held-out seed file exists");
    console.log(args.flags.has("reveal") ? seed : "held-out seed exists");
    return;
  }
  fail(`seed expects new or show, got "${action}"`);
}

/**
 * Build an adapter from a spec, and report whether the run measures anything.
 *
 * The same shape for the model under test and for the judge, because they speak the same
 * protocol. `oracle` and `oracle-judge` are harness devices: they exercise the code path without
 * measuring anything, and a run that used one is not a score.
 */
function buildAdapter(spec: string): { readonly adapter: AgentAdapter; readonly measures: boolean } {
  if (spec === "oracle") return { adapter: createOracleAgent(), measures: false };

  const parts = spec.split("|");
  if (parts.length < 3) {
    fail(`--model expects "oracle" or "<baseUrl>|<model>|<apiKeyEnvVar>", got "${spec}"`);
  }
  const baseUrl = parts[0]?.trim() ?? "";
  const model = parts[1]?.trim() ?? "";
  const keyEnv = parts[2]?.trim() ?? "";
  if (baseUrl.length === 0 || model.length === 0 || keyEnv.length === 0) {
    fail(`--model has an empty part: "${spec}"`);
  }
  const apiKey = process.env[keyEnv];
  if (!apiKey) {
    fail(
      `Environment variable ${keyEnv} is not set. Export it, or put it in a .env file next to this repository.`,
    );
  }

  return { adapter: createHttpAgent({ id: model, baseUrl, model, apiKey }), measures: true };
}

/**
 * Build the judge from its spec.
 *
 * Separate from `buildAdapter` only in what it reports back: whether the judge is the model
 * pinned for this release. An unpinned judge is allowed to run, because an evaluator may have a
 * reason, but the run then says in words that it is not valid rather than looking like a score.
 */
function buildJudge(spec: string | undefined): {
  readonly judge: JudgeAdapter | null;
  readonly judgeModel: string | null;
} {
  if (spec === undefined) return { judge: null, judgeModel: null };
  if (spec === "oracle-judge") {
    return { judge: createOracleJudge(), judgeModel: "oracle-judge" };
  }

  const parts = spec.split("|");
  if (parts.length < 3) {
    fail(`--judge expects "<baseUrl>|<model>|<apiKeyEnvVar>", got "${spec}"`);
  }
  const baseUrl = parts[0]?.trim() ?? "";
  const model = parts[1]?.trim() ?? "";
  const keyEnv = parts[2]?.trim() ?? "";
  if (baseUrl.length === 0 || model.length === 0 || keyEnv.length === 0) {
    fail(`--judge has an empty part: "${spec}"`);
  }
  const apiKey = process.env[keyEnv];
  if (!apiKey) {
    fail(
      `Environment variable ${keyEnv} is not set, so the judge cannot be reached. Export it, or put it in a .env file next to this repository.`,
    );
  }

  return { judge: createHttpAgent({ id: model, baseUrl, model, apiKey }), judgeModel: model };
}

/** Whether a run under this judge is a valid measurement. The oracle is exempt: it is a test. */
function judgeIsPinned(judgeModel: string | null): boolean {
  if (judgeModel === null) return true;
  if (judgeModel === "oracle-judge") return true;
  return isPinnedJudge(judgeModel);
}

/**
 * Give the oracle the answers, taken from the item bank rather than duplicated.
 *
 * Only graders that name a call can be answered by a scripted model; anything else is left
 * unanswered on purpose, so a category added later cannot silently pass a self-test it did not
 * participate in. Judge-graded items are the clearest case: the oracle cannot answer them, and a
 * scripted judge is what exercises that path instead.
 */
function primeOracle(oracle: OracleAgent, instances: readonly Instance[]): void {
  for (const instance of instances) {
    for (const check of instance.checks) {
      if (check.grader.type === "toolcall-exact") {
        oracle.key.set(instance.brief, { name: check.grader.tool, args: check.grader.args });
      }
    }
  }
}

function selectInstances(seed: string, filter: string | undefined): Instance[] {
  const instances = instantiateAll(seed);
  if (!filter) return instances;
  const wanted = filter.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  const chosen = instances.filter(
    (instance) => wanted.includes(instance.itemId) || wanted.includes(instance.category),
  );
  if (chosen.length === 0) fail(`--items matched nothing: "${filter}"`);
  return chosen;
}

async function runInstances(
  instances: readonly Instance[],
  adapter: AgentAdapter,
  options: {
    readonly maxTokens?: number;
    readonly quiet: boolean;
    readonly judge: JudgeAdapter | null;
    readonly judgeModel: string | null;
  },
): Promise<readonly ItemOutcome[]> {
  const outcomes: ItemOutcome[] = [];

  for (const instance of instances) {
    if (instance.judgeGraded && options.judge === null) {
      fail(
        `"${instance.itemId}" is graded by the judge, so this run needs --judge. Omitting it would score the item zero for a reason that has nothing to do with the model.`,
      );
    }

    let workflow = await runTask(instance, {
      adapter,
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      onStep: (step) => {
        if (options.quiet) return;
        const names = step.calls.map((call) => call.name).join(", ");
        console.log(`    step ${step.index + 1}: ${names}`);
      },
    });

    let judgeOutcome: JudgeOutcome | null = null;
    let modelRuns = 1;

    if (instance.judgeGraded) {
      const judged = await runJudgedTask(instance, {
        adapter,
        judge: options.judge as JudgeAdapter,
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      });
      // The first of the two runs is the one reported: it is a complete run, and reporting the
      // mean of two transcripts' step counts would be a number that describes neither.
      workflow = judged.runs[0] ?? workflow;
      judgeOutcome =
        judged.judgeFraction === null
          ? null
          : { fraction: judged.judgeFraction, judgments: judged.judgments };
      modelRuns = judged.runs.length;
    }

    const { transcript, finalState } = workflow;
    const graded = await gradeItem(instance.checks, { transcript, finalState }, judgeOutcome);
    const points = itemPointsFor(instance.category);

    outcomes.push({
      itemId: instance.itemId,
      category: instance.category,
      fraction: graded.fraction,
      checks: graded.results,
      steps: transcript.steps.length,
      endedBecause: transcript.endedBecause,
      redundantCalls: transcript.redundantCalls,
      promptTokens: transcript.promptTokens,
      completionTokens: transcript.completionTokens,
      modelRuns,
      judgeFraction: judgeOutcome === null ? null : judgeOutcome.fraction,
      efficiency: instance.efficiency,
    });

    if (!options.quiet) {
      const percent = (graded.fraction * 100).toFixed(0).padStart(3);
      const runs = modelRuns > 1 ? ` x${modelRuns}` : "";
      console.log(
        `  ${instance.itemId.padEnd(30)} ${percent}%  ${(graded.fraction * points).toFixed(2)}/${points}  ${transcript.endedBecause}${runs}`,
      );
    }
  }

  return outcomes;
}

/**
 * An empty transcript, for grading an artifact that was never produced by a model run.
 *
 * Used by the self-test, which grades a reference solution and needs a context of the right
 * shape rather than a run that happened.
 */
function emptyTranscript(): Transcript {
  return {
    steps: [],
    finalText: "",
    endedBecause: "final",
    promptTokens: 0,
    completionTokens: 0,
    redundantCalls: 0,
  };
}

/**
 * The environment a reference solution should leave behind: the file its item runs, and nothing
 * else. The entry comes from the item's own grader rather than from a constant, because two
 * recovery items run scripts the item names, not `solution.js`.
 */
function referenceFinalState(instance: Instance): EnvSnapshot | null {
  if (instance.referenceSolution === undefined) return null;
  for (const check of instance.checks) {
    if (check.grader.type === "hidden-tests") {
      return { files: { [check.grader.entry]: instance.referenceSolution }, api: {} };
    }
  }
  return null;
}

function cmdList(): void {
  validateDistribution();
  console.log("\nESAC-AG item bank");
  console.log(`  ${TOTAL_ITEMS} items, ${TOTAL_POINTS} points. ${ESAC_STATUS}.\n`);

  for (const category of CATEGORIES) {
    const items = ALL_ITEMS.filter((item) => item.category === category.id);
    const declared = ITEM_COUNTS[category.id];
    console.log(
      `  ${category.name.padEnd(32)} ${String(category.points).padStart(2)} points  ${category.grading.padEnd(13)} ${category.implemented ? `${items.length} items` : `not implemented (${declared} planned)`}`,
    );
  }

  console.log("");
  for (const category of CATEGORIES) {
    const items = ALL_ITEMS.filter((item) => item.category === category.id);
    if (items.length === 0) continue;
    console.log(`  ${category.name}`);
    for (const item of items) console.log(`    ${item.id.padEnd(30)} ${item.measures}`);
  }
  console.log("");
}

function cmdInspect(args: Args): void {
  validateBank();
  const itemId = args.positional[0];
  if (!itemId) fail("inspect requires an item id");

  const seed = args.flags.get("seed") ?? PUBLIC_DATASET_SEED;
  const instance = instantiateAll(seed).find((candidate) => candidate.itemId === itemId);
  if (!instance) fail(`no item with id "${itemId}". Run \`esac list\` to see available ids.`);

  console.log(`\n=== ${instance.itemId} (${instance.category}) ===`);
  console.log(`fingerprint: ${instance.fingerprint}`);
  console.log(`max steps:   ${instance.maxSteps}`);
  console.log(`\n--- BRIEF ---\n${instance.brief}`);
  console.log(`\n--- INITIAL STATE ---`);
  console.log(`files: ${Object.keys(instance.initial.files).length}`);
  for (const [resource, value] of Object.entries(instance.initial.api)) {
    const size = Array.isArray(value) ? `${value.length} entries` : `${Object.keys(value as object).length} rows`;
    console.log(`  ${resource}: ${size}`);
  }
  console.log(`\n--- CHECKS ---`);
  for (const check of instance.checks) {
    console.log(`  ${check.id} (weight ${check.weight}), ${check.grader.type}`);
    if (check.grader.type === "toolcall-exact") {
      console.log(`    expected: ${check.grader.tool} ${JSON.stringify(check.grader.args)}`);
    }
  }
  console.log(`\n--- TOOLS ---`);
  for (const operation of instance.operations) console.log(`  ${operation.name}  (${operation.required.join(", ")})`);
  console.log("");
}

async function cmdRun(args: Args): Promise<void> {
  validateBank();

  const pool = resolvePool(args);
  const seed = pool.seed;
  const instances = selectInstances(seed, args.flags.get("items"));
  const modelSpec = args.flags.get("model") ?? "oracle";
  const { adapter, measures } = buildAdapter(modelSpec);
  const maxTokensRaw = args.flags.get("max-tokens");
  const maxTokens = maxTokensRaw === undefined ? undefined : Number(maxTokensRaw);
  if (maxTokens !== undefined && (!Number.isFinite(maxTokens) || maxTokens <= 0)) {
    fail(`--max-tokens expects a positive number, got "${maxTokensRaw}"`);
  }
  const quiet = args.flags.has("quiet");
  const { judge, judgeModel } = buildJudge(args.flags.get("judge"));

  console.log(`\nESAC-AG: ${instances.length} of ${TOTAL_ITEMS} items, ${pool.split} pool, model ${adapter.id}`);
  console.log(`status: ${ESAC_STATUS}`);
  if (instances.some((instance) => instance.judgeGraded)) {
    console.log(`judge: ${judgeModel}`);
    if (!judgeIsPinned(judgeModel)) {
      console.log(
        `WARNING: the judge is not the model pinned for this release (${PINNED_JUDGE}). The judged share of this run will not be a valid measurement.`,
      );
    }
  }
  if (!measures) {
    console.log("NOTE: the oracle adapter exercises the harness. It does not measure a model.\n");
  } else {
    console.log(`decoding: temperature ${DECODING.temperature}, cap ${maxTokens ?? OUTPUT_LIMITS.modelTokens} tokens\n`);
  }

  const started = Date.now();
  const outcomes = await runInstances(instances, adapter, {
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    quiet,
    judge,
    judgeModel,
  });

  const report = scoreRun({
    items: outcomes,
    model: adapter.id,
    datasetSeedFingerprint: seedFingerprint(seed),
    split: pool.split,
    durationMs: Date.now() - started,
    judge: judgeModel,
    judgePinned: judgeIsPinned(judgeModel),
  });

  console.log(renderReport(report, { verbose: args.flags.has("verbose") }));

  const jsonPath = args.flags.get("json");
  if (jsonPath) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, toJson(report), "utf8");
    console.log(`Full report written to ${jsonPath}\n`);
  }

  process.exit(report.verdict === "pass" ? 0 : 1);
}

/**
 * The offline self-check.
 *
 * This build is not a benchmark, so the self-test cannot assert a score. What it asserts is that
 * every claim the repository makes about itself is still true, and each assertion is one of those
 * claims:
 *
 *  1. the item the oracle can answer is answered perfectly, so the harness runs and grades;
 *  2. every item graded by running code ships a reference solution that passes its own hidden
 *     tests, so no item is unsolvable and no expectation is wrong;
 *  3. no item is passed by a run that does nothing, so partial credit cannot be farmed;
 *  4. every judged item runs the 2x2 protocol, so the judge path is exercised rather than
 *     assumed;
 *  5. a run over a partially implemented suite is INCOMPLETE rather than a score.
 *
 * The scripted judge scores zero on purpose. A judge that returned full marks would let the
 * oracle's do-nothing run pass the judged category, and assertion 3 is worth more than a
 * flattering self-test.
 */
async function cmdSelftest(): Promise<void> {
  validateDistribution();
  validateBank();

  console.log("\nESAC-AG self-test");
  console.log(`  implementation ${ESAC_IMPLEMENTATION_VERSION}, ${ESAC_STATUS}`);
  console.log(`  ${describeSandbox()}\n`);

  const instances = instantiateAll(PUBLIC_DATASET_SEED);
  const oracle = createOracleAgent();
  primeOracle(oracle, instances);
  const judge = createOracleJudge({ fractions: [0] });

  const outcomes = await runInstances(instances, oracle, {
    quiet: true,
    judge,
    judgeModel: judge.id,
  });
  const report = scoreRun({
    items: outcomes,
    model: "oracle",
    datasetSeedFingerprint: seedFingerprint(PUBLIC_DATASET_SEED),
    split: "public",
    durationMs: 0,
    judge: judge.id,
    judgePinned: judgeIsPinned(judge.id),
  });

  const problems: string[] = [];

  // 4. The judged items ran the protocol, not a single judgment.
  for (const instance of instances) {
    if (!instance.judgeGraded) continue;
    const outcome = outcomes.find((candidate) => candidate.itemId === instance.itemId);
    if (outcome === undefined) {
      problems.push(`${instance.itemId}: no outcome was produced`);
      continue;
    }
    if (outcome.modelRuns !== REPLICATION.judgeModelRuns) {
      problems.push(
        `${instance.itemId}: ran the model ${outcome.modelRuns} times, expected ${REPLICATION.judgeModelRuns}`,
      );
    }
    if (outcome.judgeFraction === null) {
      problems.push(`${instance.itemId}: judge-graded but no judge fraction was recorded`);
    }
  }

  // 1. The oracle answers the items it was given a call for. Everything else is left for the
  //    checks below, rather than being reported as a failure the oracle was never meant to pass.
  for (const outcome of outcomes) {
    const instance = instances.find((candidate) => candidate.itemId === outcome.itemId);
    const answerable = instance?.checks.some((check) => check.grader.type === "toolcall-exact") ?? false;
    const scored = outcome.checks.reduce((sum, check) => sum + check.fraction, 0);
    if (answerable && outcome.fraction !== 1) {
      problems.push(`${outcome.itemId}: the oracle scored ${outcome.fraction}, expected 1`);
    }
    if (!answerable && outcome.fraction >= 1) {
      problems.push(`${outcome.itemId}: a run that did nothing scored 1`);
    }
    if (answerable && scored === 0) problems.push(`${outcome.itemId}: nothing was graded`);
  }

  // 2. Every reference solution passes the tests its own item generates.
  let references = 0;
  for (const instance of instances) {
    const finalState = referenceFinalState(instance);
    if (finalState === null) continue;
    const graded = await gradeChecks(instance.checks, {
      transcript: emptyTranscript(),
      finalState,
    });
    references++;
    if (graded.fraction !== 1) {
      const detail = graded.results[0]?.detail ?? "no detail";
      problems.push(`${instance.itemId}: the reference solution scored ${graded.fraction} (${detail})`);
    }
  }
  if (references === 0) problems.push("no item ships a reference solution");

  console.log(renderReport(report));

  if (problems.length > 0) {
    console.error("self-test failed:");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }

  console.log(
    `Self-test passed: the harness runs and grades, ${references} reference solutions pass their own hidden tests, no item is passed by doing nothing, and a partial run is reported as INCOMPLETE rather than as a score.\n`,
  );
}

function cmdVersion(): void {
  console.log(`\n${ESAC_VERSION_TAG}`);
  console.log(`implementation ${ESAC_IMPLEMENTATION_VERSION}`);
  console.log(`status: ${ESAC_STATUS}`);
  console.log(`canary: ${CANARY}`);
  console.log(`step budget: ${STEP_BUDGET.min} to ${STEP_BUDGET.max} tool calls per task\n`);
}

/**
 * Report the judge.
 *
 * Its own command because the pinned judge is part of what a score means, and because the most
 * common failure is a missing key rather than a wrong model. Saying which variable is missing,
 * by name, is more useful than a failed run three minutes in.
 */
function cmdJudge(): void {
  const keyPresent = (process.env[DEFAULT_JUDGE_KEY_ENV] ?? "").length > 0;
  console.log("\nESAC-AG judge");
  console.log(`  pinned model: ${PINNED_JUDGE}`);
  console.log(`  why: ${PINNED_JUDGE_RATIONALE}`);
  console.log(`  default: --judge ${DEFAULT_JUDGE_SPEC}`);
  console.log(
    `  key: ${DEFAULT_JUDGE_KEY_ENV} is ${keyPresent ? "set" : "NOT set"}, so a judged run ${
      keyPresent ? "can reach the endpoint" : "cannot reach the endpoint"
    }`,
  );
  console.log(
    `  replication: ${REPLICATION.judgeModelRuns} model runs, ${REPLICATION.judgeJudgmentsPerResponse} judgments each, averaged`,
  );
  console.log(
    `  scope: ${JUDGE_GRADED_POINTS} of ${TOTAL_POINTS} points. A run under any other judge is reported as NOT VALID rather than as a score.\n`,
  );
}

/**
 * Report the sandbox.
 *
 * Worth its own command because the answer decides whether two of the seven categories can be
 * scored at all, and because it is the one part of this repository that runs code the model
 * wrote. A run prints the same line before it starts.
 */
function cmdSandbox(): void {
  console.log("\nESAC-AG execution sandbox");
  console.log(`  ${describeSandbox()}\n`);
}

function helpText(): string {
  return `
ESAC-AG: EcoWestern Short and Cheap Agentic Work and Capability Benchmark

  esac list                                  show the item bank and point allocation
  esac inspect <itemId> [--seed <s>]         render one generated instance
  esac run [options]                         run the suite
  esac selftest                              verify the harness end to end, offline
  esac sandbox                               whether generated code can run here, and why not
  esac judge                                 the pinned judge, and whether its key is set
  esac seed new [--force] [--out <path>]    generate an ignored held-out seed file
  esac seed show [--reveal]                 show whether the held-out seed file exists
  esac version                               print the implementation version and canary

run options:
  --model <spec>     "oracle" (harness self-test) or "<baseUrl>|<model>|<envVar>"
  --judge <spec>     the same shape, or "oracle-judge". Required when the selection includes
                     a judged item. Default: ${DEFAULT_JUDGE_SPEC}
  --split <pool>     public (default) or heldout. There is no combined mode.
  --items <list>     comma-separated item ids or category ids
  --seed <s>         dataset seed (default: ${PUBLIC_DATASET_SEED})
  --max-tokens <n>   output cap for the model under test (default ${OUTPUT_LIMITS.modelTokens})
  --json <path>      write the full report as JSON
  --verbose          include per-check detail in the report
  --quiet            suppress the per-item progress tally

Notes:
  Keys are read from the environment, or from a .env file next to this repository, which
  never overrides a variable that is already set.
  This build is not a benchmark. Six of the seven categories have no items, so a full run is
  reported as INCOMPLETE and no comparable ESAC-AG score can exist. The specification, not this
  repository, defines what the suite is: see EcoWestern/ESAC.
`;
}

async function main(): Promise<void> {
  // Before anything reads the environment, so a key in a .env file is available to a run that
  // names the variable rather than the key.
  loadDotEnv();

  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "list":
      cmdList();
      break;
    case "inspect":
      cmdInspect(args);
      break;
    case "run":
      await cmdRun(args);
      break;
    case "selftest":
      await cmdSelftest();
      break;
    case "sandbox":
      cmdSandbox();
      break;
    case "judge":
      cmdJudge();
      break;
    case "seed":
      cmdSeed(args);
      break;
    case "version":
      cmdVersion();
      break;
    case "help":
    case "":
      console.log(helpText());
      break;
    default:
      fail(`unknown command "${args.command}". Run \`esac help\`.`);
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof InfrastructureError) {
    console.error(`\n  infrastructure failure: ${error.message}`);
    console.error("  Nothing was scored. This is not a model result.\n");
    process.exit(2);
  }
  throw error;
}
