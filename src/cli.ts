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
 *   --model <spec>     "oracle" (harness self-test), a model id, or "<baseUrl>|<model>|<apiKeyEnvVar>"
 *   --judge <spec>     same shape, or "oracle-judge". Required for a judging run; not for a dry run.
 *   --split <pool>     public (default) or heldout. There is no combined mode.
 *   --items <list>     comma-separated item ids or category ids
 *   --allow-unpinned-judge  run with a judge other than the one pinned for this release
 *   --seed <s>         dataset seed (default: the disclosed public seed)
 *   --max-tokens <n>   output cap for the model under test
 *   --json <path>      write the full report as JSON
 *   --verbose          include per-check detail in the report
 *   --quiet            suppress the per-item progress tally
 *
 * Exit codes, so a caller can tell a result from a non-result:
 *   0  a valid pass
 *   1  a valid fail, or a run that did not cover the suite
 *   2  infrastructure failure, so nothing was scored
 *   3  not a valid ESAC-AG result, because the judge was substituted
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  CATEGORIES,
  ITEM_COUNTS,
  JUDGE_GRADED_POINTS,
  TOTAL_ITEMS,
  TOTAL_POINTS,
  itemPointsFor,
  validateDistribution,
  type CategoryId,
} from "./categories.ts";
import { ALL_ITEMS, instantiateAll, seedFingerprint, validateBank } from "./registry.ts";
import { writeArtifact } from "./artifact.ts";
import { gradeChecks, gradeItem, type JudgeOutcome } from "./graders.ts";
import { runJudgedTask, runTask } from "./runner.ts";
import { scoreRun, renderFinalReport, renderReport, toJson, type ItemOutcome } from "./score.ts";
import { createHttpAgent, createOracleAgent, createOracleJudge, type OracleAgent } from "./adapters.ts";
import { describeSandbox } from "./env/sandbox.ts";
import { loadDotEnv } from "./env.ts";
import { generateSeed, missingSeedMessage, readSeedFile, resolveHeldOutSeed, writeSeedFile } from "./seedfile.ts";
import { parseExtraBody, parseMaxTokens, parseThinkingTokens } from "./flags.ts";
import {
  CANARY,
  DECODING,
  DEFAULT_JUDGE_KEY_ENV,
  DEFAULT_JUDGE_SPEC,
  ESAC_IMPLEMENTATION_VERSION,
  ESAC_STATUS,
  ESAC_VERSION_TAG,
  OUTPUT_LIMITS,
  PASS_THRESHOLD,
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

/**
 * The flags each command accepts.
 *
 * Checked before anything runs, because a permissive parser silently ignores an option it does
 * not know: a typo in `--items` would then run the whole suite, which costs money and produces a
 * result nobody asked for. A usage error is the cheaper outcome by far.
 *
 * Kept beside the dispatcher rather than derived from the parsers, because the point of the
 * check is to be independent of them: a flag missing from this table is a flag that cannot be
 * passed, which is a visible failure rather than a silent no-op.
 */
const COMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {
  list: [],
  export: ["split", "out", "seed", "verify"],
  inspect: ["seed"],
  key: ["split", "out", "seed"],
  run: [
    "model",
    "judge",
    "allow-unpinned-judge",
    "split",
    "items",
    "seed",
    "max-tokens",
    "thinking-tokens",
    "extra-body",
    "json",
    "verbose",
    "quiet",
  ],
  auto: [
    "model",
    "judge",
    "allow-unpinned-judge",
    "split",
    "items",
    "seed",
    "max-tokens",
    "thinking-tokens",
    "extra-body",
    "json",
    "verbose",
    "quiet",
    "yes",
  ],
  selftest: [],
  sandbox: [],
  judge: [],
  seed: ["out", "force", "reveal"],
  version: [],
  help: ["help"],
  "": ["help"],
};

/** Refuse an option the command does not define, rather than ignoring it. */
function rejectUnknownFlags(args: Args): void {
  const allowed = COMMAND_FLAGS[args.command];
  // An unknown command is the dispatcher's error to report, with a better message than this one.
  if (allowed === undefined) return;

  const unknown = [...args.flags.keys()].filter((name) => !allowed.includes(name));
  if (unknown.length === 0) return;

  const list = unknown.map((name) => `--${name}`).join(", ");
  fail(
    `unknown option${unknown.length === 1 ? "" : "s"} for "${args.command || "esac"}": ${list}.\n` +
      "  Run `esac help` for the options a command takes.",
  );
}

function resolvePool(args: Args): { readonly split: "public" | "heldout"; readonly seed: string } {
  const raw = args.flags.get("split") ?? "public";
  if (raw !== "public" && raw !== "heldout") {
    fail(
      raw === "both"
        ? '--split no longer takes "both": one run is one pool. Run the two pools separately and compare the reports.'
        : `--split must be public or heldout (got "${raw}")`,
    );
  }
  if (raw === "public") return { split: raw, seed: args.flags.get("seed") ?? PUBLIC_DATASET_SEED };
  // Flag, then environment, then the ignored seed file, then a refusal. Refusing is deliberate:
  // a seed invented on the spot could not be reproduced afterwards, and that is not a run.
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

/** A base URL that does not parse is a usage error, not a transport failure. */
function assertBaseUrl(flag: string, baseUrl: string): void {
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    fail(`${flag}: "${baseUrl}" is not a URL. Include the scheme, for example ${DEFAULT_BASE_URL}`);
  }
  if (host.length === 0) fail(`${flag}: "${baseUrl}" has no host`);
}

/**
 * Build an adapter from a spec, and report whether the run measures anything.
 *
 * The same shape for the model under test and for the judge, because they speak the same
 * protocol. `oracle` and `oracle-judge` are harness devices: they exercise the code path without
 * measuring anything, and a run that used one is not a score.
 */
function buildAdapter(spec: string, extraBody?: Record<string, unknown>): { readonly adapter: AgentAdapter; readonly measures: boolean } {
  if (spec === "oracle") return { adapter: createOracleAgent(), measures: false };

  // The key variable is optional: a local endpoint needs none, and requiring a name the caller
  // does not have would make a self-hosted model unusable.
  const parts = spec.split("|");
  if (parts.length < 2) {
    fail(`--model expects "oracle" or "<baseUrl>|<model>|<apiKeyEnvVar>", got "${spec}"`);
  }
  const baseUrl = parts[0]?.trim() ?? "";
  const model = parts[1]?.trim() ?? "";
  const keyEnv = parts[2]?.trim() ?? "";
  if (baseUrl.length === 0 || model.length === 0) {
    fail(`--model has an empty part: "${spec}"`);
  }
  // Validated before the run rather than at the first request, so a mistyped URL is a usage error
  // and not an infrastructure failure that reads like an outage.
  assertBaseUrl("--model", baseUrl);

  const apiKey = keyEnv ? (process.env[keyEnv] ?? "") : "";
  if (keyEnv && !apiKey) {
    fail(
      `Environment variable ${keyEnv} is not set. Export it, or put it in a .env file next to this repository.`,
    );
  }

  return { adapter: createHttpAgent({ id: model, baseUrl, model, apiKey, ...(extraBody ? { extraBody } : {}) }), measures: true };
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
  if (parts.length < 2) {
    fail(`--judge expects "<baseUrl>|<model>|<apiKeyEnvVar>", got "${spec}"`);
  }
  const baseUrl = parts[0]?.trim() ?? "";
  const model = parts[1]?.trim() ?? "";
  const keyEnv = parts[2]?.trim() ?? "";
  if (baseUrl.length === 0 || model.length === 0) {
    fail(`--judge has an empty part: "${spec}"`);
  }
  assertBaseUrl("--judge", baseUrl);

  const apiKey = keyEnv ? (process.env[keyEnv] ?? "") : "";
  if (keyEnv && !apiKey) {
    fail(
      `Environment variable ${keyEnv} is not set, so the judge cannot be reached. Export it, or put it in a .env file next to this repository.`,
    );
  }

  return { judge: createHttpAgent({ id: model, baseUrl, model, apiKey }), judgeModel: model };
}

/**
 * Whether a run under this judge is a valid measurement.
 *
 * The scripted judge is exempt on purpose: it is a harness device that measures nothing, and the
 * self-test depends on it reaching a verdict. A run under it is not a score either way, which the
 * oracle note in the report says in words.
 */
function judgeIsPinned(judgeModel: string | null): boolean {
  if (judgeModel === null) return true;
  if (judgeModel === "oracle-judge") return true;
  return isPinnedJudge(judgeModel);
}

/**
 * Enforce judge discipline before a run spends anything.
 *
 * Deliberately the same shape as ESAC-GI's, because two suites with different rules about what
 * makes a result valid would be two standards. An unpinned judge is refused unless the caller
 * accepts that the result is exploratory, and a dry run is exempt from the judge requirement
 * entirely: `--model oracle` exists to prove the harness works, not to measure a model, and
 * refusing it leaves the documented dry run unable to run.
 */
function enforceJudgeDiscipline(options: {
  readonly judgeGradedPresent: boolean;
  readonly judgeModel: string | null;
  readonly dryRun: boolean;
  readonly allowUnpinnedJudge: boolean;
}): void {
  const { judgeGradedPresent, judgeModel, dryRun, allowUnpinnedJudge } = options;
  if (!judgeGradedPresent) return;

  if (judgeModel === null && !dryRun) {
    fail(
      "this selection includes judge-graded items, so --judge is required.\n" +
        `  The judge must be open-weight and pinned per release (${PINNED_JUDGE}). An aggregator\n` +
        "  such as OpenRouter is the recommended way to reach one.\n" +
        `  Example: --judge ${DEFAULT_JUDGE_SPEC}`,
    );
  }

  const substituted =
    judgeModel !== null && judgeModel !== "oracle-judge" && !judgeIsPinned(judgeModel);
  if (substituted && !allowUnpinnedJudge) {
    fail(
      `judge "${judgeModel}" is not the judge pinned for this release (${PINNED_JUDGE}).\n` +
        "  Rubric scores are only comparable across runs that used the pinned judge, so an\n" +
        "  unpinned judge is refused by default. Pass --allow-unpinned-judge to run anyway;\n" +
        "  the run will be reported without a verdict, because a substituted judge decides\n" +
        "  a whole category and the number would not be an ESAC-AG score.",
    );
  }
}

/**
 * Exit codes, so a caller can tell a result from a non-result.
 *
 * Same contract as ESAC-GI: a valid pass, a valid fail, an infrastructure failure, and a run that
 * is not a valid result because the judge was substituted all exit differently. INCOMPLETE shares
 * the fail code because it is the absence of a score rather than a distinct outcome.
 */
function exitCodeFor(report: { readonly verdict: string }): number {
  if (report.verdict === "pass") return 0;
  if (report.verdict === "not-valid") return 3;
  return 1;
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

/**
 * The judge a run will actually use.
 *
 * A judged item with no judge would score zero for a reason that has nothing to do with the
 * model, so that combination is refused rather than guessed at. The exception is a dry run:
 * `--model oracle` without `--judge` gets a scripted judge, which is what lets the documented
 * dry run work while still exercising the judged code path end to end.
 */
function judgeFor(judge: JudgeAdapter | null, dryRun: boolean): JudgeAdapter | null {
  if (judge !== null) return judge;
  return dryRun ? createOracleJudge() : null;
}

async function runInstances(
  instances: readonly Instance[],
  adapter: AgentAdapter,
  options: {
    readonly maxTokens?: number;
    readonly quiet: boolean;
    readonly judge: JudgeAdapter | null;
    /** Called after each item resolves, for auto mode's section-by-section output. */
    readonly onItem?: (outcome: ItemOutcome) => void;
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

    const outcome: ItemOutcome = {
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
    };
    outcomes.push(outcome);

    if (!options.quiet) {
      const percent = (graded.fraction * 100).toFixed(0).padStart(3);
      const runs = modelRuns > 1 ? ` x${modelRuns}` : "";
      console.log(
        `  ${instance.itemId.padEnd(30)} ${percent}%  ${(graded.fraction * points).toFixed(2)}/${points}  ${transcript.endedBecause}${runs}`,
      );
    }

    options.onItem?.(outcome);
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

function cmdExport(args: Args): void {
  validateBank();
  const pool = resolvePool(args);
  const output = resolve(args.flags.get("out") ?? `public/esac-ag-v1.0-${pool.split}.jsonl`);
  const verify = args.flags.has("verify");
  const result = writeArtifact(output, pool.split, pool.seed, { verify });

  if (verify) {
    if (!result.unchanged) fail(`${output} is not reproducible from the selected seed`);
    console.log(`${output} is reproducible: ${result.itemCount} instances match the ${pool.split} seed`);
    return;
  }
  console.log(`wrote ${result.itemCount} instances to ${output}`);
}

function cmdKey(args: Args): void {
  const pool = resolvePool({ ...args, flags: new Map([...args.flags, ["split", args.flags.get("split") ?? "heldout"]]) });
  const output = resolve(args.flags.get("out") ?? `runs/${pool.split}-key.json`);
  const instances = instantiateAll(pool.seed);
  const key = instances.map((instance) => ({
    itemId: instance.itemId,
    category: instance.category,
    fingerprint: instance.fingerprint,
    checks: instance.checks.map((check) => ({ id: check.id, weight: check.weight, grader: check.grader })),
  }));
  const body = JSON.stringify(
    { versionTag: ESAC_VERSION_TAG, pool: pool.split, seedFingerprint: seedFingerprint(pool.seed), items: key },
    null,
    2,
  );
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${body}\n`, "utf8");
  console.log(`scoring key written to ${output}`);
}

/**
 * Read a flag and parse it, turning a parser complaint into CLI output.
 *
 * Shared by the run flags so that every structured value reports the same way: one error shape,
 * on stderr, before the run starts.
 */
function parseFlag<T>(args: Args, name: string, parse: (raw: string) => T): T | undefined {
  const raw = args.flags.get(name);
  if (raw === undefined) return undefined;
  try {
    return parse(raw);
  } catch (error) {
    fail(`--${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_KEY_ENV = "OPENROUTER_API_KEY";

function normaliseModelSpec(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "oracle" || trimmed.includes("|")) return trimmed;
  return `${DEFAULT_BASE_URL}|${trimmed}|${DEFAULT_KEY_ENV}`;
}

function normaliseJudgeSpec(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "oracle-judge" || trimmed.includes("|")) return trimmed;
  return `${DEFAULT_BASE_URL}|${trimmed}|${DEFAULT_KEY_ENV}`;
}

/**
 * Ask for the arguments a run needs, then hand them back as flags.
 *
 * `--yes` never prompts, which is what makes auto mode usable from a script: it requires
 * `--model`, because there is no sensible default for what to measure and silently running the
 * oracle would look like a result.
 */
async function autoConfig(args: Args): Promise<Args> {
  const answeredModel = args.flags.get("model");
  const flags = new Map(args.flags);

  if (args.flags.has("yes")) {
    if (answeredModel === undefined) {
      fail("auto --yes requires --model, because there is no default for what to measure");
    }
    flags.set("model", normaliseModelSpec(answeredModel));
    flags.set("split", args.flags.get("split") ?? "public");
    flags.set("judge", normaliseJudgeSpec(args.flags.get("judge") ?? "oracle-judge"));
    return { command: "run", flags, positional: args.positional };
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (prompt: string, fallback: string): Promise<string> => {
    const answer = (await rl.question(`${prompt} [${fallback}] > `)).trim();
    return answer || fallback;
  };
  try {
    console.log("\nESAC-AG auto mode\n");
    flags.set("model", normaliseModelSpec(await ask("Model (id or baseUrl|model|envVar)", answeredModel ?? "oracle")));
    flags.set("split", await ask("Pool (public or heldout)", args.flags.get("split") ?? "public"));
    flags.set("judge", normaliseJudgeSpec(await ask("Judge (id, baseUrl|model|envVar, or oracle-judge)", args.flags.get("judge") ?? "oracle-judge")));
    return { command: "run", flags, positional: args.positional };
  } finally {
    rl.close();
  }
}

/**
 * Auto mode: ask for the basics, run, and report section by section.
 *
 * The presentation differs from `run` on purpose. `run` is for someone who already has a spec in
 * hand and wants a per-item tally; `auto` is for someone who wants to see each section close and
 * then read one summary. Both go through the same execution path, so the two cannot disagree
 * about what a score means.
 */
async function cmdAuto(args: Args): Promise<void> {
  const config = await autoConfig(args);
  await cmdRun(config, { sectioned: true });
}

/** Per-category progress, so auto mode can report a section the moment its last item resolves. */
function makeCategoryProgress(instances: readonly Instance[]) {
  const totals = new Map<CategoryId, { items: number; points: number; awarded: number; done: number }>();
  for (const instance of instances) {
    const entry = totals.get(instance.category) ?? { items: 0, points: 0, awarded: 0, done: 0 };
    entry.items += 1;
    entry.points += itemPointsFor(instance.category);
    totals.set(instance.category, entry);
  }

  return {
    /** The section totals once its last item has resolved, else null. */
    record(result: ItemOutcome): { readonly id: CategoryId; readonly awarded: number; readonly points: number } | null {
      const entry = totals.get(result.category);
      if (!entry) return null;
      entry.done += 1;
      entry.awarded += result.fraction * itemPointsFor(result.category);
      if (entry.done < entry.items) return null;
      return { id: result.category, awarded: entry.awarded, points: entry.points };
    },
  };
}

async function cmdRun(args: Args, options: { readonly sectioned?: boolean } = {}): Promise<void> {
  validateBank();

  const pool = resolvePool(args);
  const seed = pool.seed;
  const instances = selectInstances(seed, args.flags.get("items"));
  const modelSpec = args.flags.get("model") ?? "oracle";
  const dryRun = modelSpec === "oracle";
  // Each flag reports under its own name, so a bad value says which flag produced it. An explicit
  // --extra-body wins over one --thinking-tokens generated, so a caller can override a field.
  const thinkingBody = parseFlag(args, "thinking-tokens", parseThinkingTokens);
  const rawBody = parseFlag(args, "extra-body", parseExtraBody);
  const extraBody = thinkingBody || rawBody ? { ...(thinkingBody ?? {}), ...(rawBody ?? {}) } : undefined;
  const { adapter, measures } = buildAdapter(modelSpec, extraBody);
  // A whole number, checked by the shared parser, so a fractional cap is a usage error rather
  // than a silently truncated budget that makes the report's stated conditions false.
  const maxTokens = parseFlag(args, "max-tokens", parseMaxTokens);
  const quiet = args.flags.has("quiet");
  const { judge, judgeModel } = buildJudge(args.flags.get("judge"));
  const judgeGradedPresent = instances.some((instance) => instance.judgeGraded);

  enforceJudgeDiscipline({
    judgeGradedPresent,
    judgeModel,
    dryRun,
    allowUnpinnedJudge: args.flags.has("allow-unpinned-judge"),
  });

  const activeJudge = judgeFor(judge, dryRun);
  const activeJudgeModel = judgeModel ?? (activeJudge !== null ? activeJudge.id : null);

  console.log(`\nESAC-AG: ${instances.length} of ${TOTAL_ITEMS} items, ${pool.split} pool, model ${adapter.id}`);
  console.log(`status: ${ESAC_STATUS}`);
  if (judgeGradedPresent) {
    console.log(`judge: ${activeJudgeModel}`);
    if (!judgeIsPinned(activeJudgeModel)) {
      console.log(
        `WARNING: judge "${activeJudgeModel}" is not the pinned judge (${PINNED_JUDGE}). This run is exploratory, and its rubric scores are not comparable with official runs.`,
      );
    }
  }
  if (!measures) {
    console.log("NOTE: the oracle adapter exercises the harness. It does not measure a model.\n");
  } else {
    console.log(`decoding: temperature ${DECODING.temperature}, cap ${maxTokens ?? OUTPUT_LIMITS.modelTokens} tokens\n`);
  }

  const sectioned = options.sectioned === true;
  const progress = sectioned ? makeCategoryProgress(instances) : null;
  if (sectioned) {
    console.log("Section results appear below as each section completes.\n");
  }

  const started = Date.now();
  const outcomes = await runInstances(instances, adapter, {
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    quiet,
    judge: activeJudge,
    ...(progress
      ? {
          onItem: (result: ItemOutcome) => {
            const section = progress.record(result);
            if (section === null) return;
            const name = CATEGORIES.find((category) => category.id === section.id)?.name ?? section.id;
            const percent = `${((section.awarded / section.points) * 100).toFixed(1)}%`.padStart(7);
            const raw = `${section.awarded.toFixed(2)} / ${section.points}`.padStart(14);
            console.log(`\n  SECTION  ${name.padEnd(33).slice(0, 33)} ${raw} ${percent}\n`);
          },
        }
      : {}),
  });

  const report = scoreRun({
    items: outcomes,
    model: adapter.id,
    datasetSeedFingerprint: seedFingerprint(seed),
    split: pool.split,
    durationMs: Date.now() - started,
    judge: activeJudgeModel,
    judgePinned: judgeIsPinned(activeJudgeModel),
  });

  console.log(
    sectioned ? renderFinalReport(report) : renderReport(report, { verbose: args.flags.has("verbose") }),
  );

  const jsonPath = args.flags.get("json");
  if (jsonPath) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, toJson(report), "utf8");
    console.log(`Full report written to ${jsonPath}\n`);
  }

  process.exit(exitCodeFor(report));
}

/**
 * The offline self-check.
 *
 * It asserts no score, because a self-test that measured nothing should not report a number.
 * What it asserts is that every claim the repository makes about itself is still true, and each
 * assertion is one of those claims:
 *
 *  1. the item the oracle can answer is answered perfectly, so the harness runs and grades;
 *  2. every item graded by running code ships a reference solution that passes its own hidden
 *     tests, so no item is unsolvable and no expectation is wrong;
 *  3. no item is passed by a run that does nothing, so partial credit cannot be farmed;
 *  4. every judged item runs the 2x2 protocol, so the judge path is exercised rather than
 *     assumed;
 *  5. every category is implemented, and a run that leaves one out is INCOMPLETE rather than a
 *     score.
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
    `Self-test passed: the harness runs and grades, ${references} reference solutions pass their own hidden tests, no item is passed by doing nothing, the judged items ran the 2x2 protocol, and a run that leaves a category out is reported as INCOMPLETE rather than as a score.\n`,
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
  esac export [--split public|heldout]       write a JSONL snapshot of a pool
  esac inspect <itemId> [--seed <s>]         render one generated instance
  esac key [--split heldout] [--out <file>]  emit the scoring key for a pool
  esac run [options]                         run the suite
  esac auto [options]                        guided setup, then a run
  esac selftest                              verify the harness end to end, offline
  esac sandbox                               whether generated code can run here, and why not
  esac judge                                 the pinned judge, and whether its key is set
  esac seed new [--force] [--out <path>]    generate an ignored held-out seed file
  esac seed show [--reveal]                 show whether the held-out seed file exists
  esac version                               print the implementation version and canary

run options:
  --model <spec>     "oracle", a model id on OpenRouter, or "<baseUrl>|<model>|<envVar>"
  --judge <spec>     a model id, the same adapter shape, or "oracle-judge". Required when the selection includes
                     a judged item. Default: ${DEFAULT_JUDGE_SPEC}
  --split <pool>     public (default) or heldout. There is no combined mode.
  --items <list>     comma-separated item ids or category ids
  --seed <s>         dataset seed (default: ${PUBLIC_DATASET_SEED})
  --max-tokens <n>   output cap for the model under test (default ${OUTPUT_LIMITS.modelTokens})
  --thinking-tokens <n> separate hidden reasoning budget where supported
  --extra-body <json> extra JSON merged into model requests
  --json <path>      write the full report as JSON
  --verbose          include per-check detail in the report
  --quiet            suppress the per-item progress tally

Notes:
  Keys are read from the environment, or from a .env file next to this repository, which
  never overrides a variable that is already set.
  The full suite is 75 points across seven categories. Passing requires
  ${(PASS_THRESHOLD.perCategory * 100).toFixed(0)}% in every category plus ${(PASS_THRESHOLD.overall * 100).toFixed(0)}% overall, so a strong average
  cannot rescue a weak category.
  A full run is PASS, FAIL, or INCOMPLETE. A filtered run, or one that leaves a category out,
  is INCOMPLETE: the percentage is against the whole suite and is not a comparable score.
  A run under a judge other than ${PINNED_JUDGE} is reported as NOT VALID and exits 3,
  because that judge decides ${JUDGE_GRADED_POINTS} of the ${TOTAL_POINTS} points.
  Scores are only comparable within the same major version (${ESAC_VERSION_TAG}).
  The specification, not this repository, defines what the suite is: see EcoWestern/ESAC.
`;
}

async function main(): Promise<void> {
  // Before anything reads the environment, so a key in a .env file is available to a run that
  // names the variable rather than the key.
  loadDotEnv();

  const args = parseArgs(process.argv.slice(2));
  rejectUnknownFlags(args);

  switch (args.command) {
    case "list":
      cmdList();
      break;
    case "export":
      cmdExport(args);
      break;
    case "inspect":
      cmdInspect(args);
      break;
    case "key":
      cmdKey(args);
      break;
    case "run":
      await cmdRun(args);
      break;
    case "auto":
      await cmdAuto(args);
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
    case "--help":
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
