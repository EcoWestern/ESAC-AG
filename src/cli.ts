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
  TOTAL_ITEMS,
  TOTAL_POINTS,
  itemPointsFor,
  validateDistribution,
} from "./categories.ts";
import { ALL_ITEMS, instantiateAll, seedFingerprint, validateBank } from "./registry.ts";
import { gradeChecks } from "./graders.ts";
import { runTask } from "./runner.ts";
import { scoreRun, renderReport, toJson, type ItemOutcome } from "./score.ts";
import { createHttpAgent, createOracleAgent, type OracleAgent } from "./adapters.ts";
import { describeSandbox } from "./env/sandbox.ts";
import {
  CANARY,
  DECODING,
  ESAC_IMPLEMENTATION_VERSION,
  ESAC_STATUS,
  ESAC_VERSION_TAG,
  OUTPUT_LIMITS,
  PUBLIC_DATASET_SEED,
  STEP_BUDGET,
} from "./version.ts";
import { InfrastructureError } from "./types.ts";
import type { AgentAdapter, EnvSnapshot, Instance, Transcript } from "./types.ts";

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

/** Build an adapter from a spec, and report whether the run measures anything. */
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
 * Give the oracle the answers, taken from the item bank rather than duplicated.
 *
 * Only graders that name a call can be answered by a scripted model; anything else is left
 * unanswered on purpose, so a category added later cannot silently pass a self-test it did not
 * participate in.
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
  options: { readonly maxTokens?: number; readonly quiet: boolean },
): Promise<readonly ItemOutcome[]> {
  const outcomes: ItemOutcome[] = [];

  for (const instance of instances) {
    const { transcript, finalState } = await runTask(instance, {
      adapter,
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      onStep: (step) => {
        if (options.quiet) return;
        const names = step.calls.map((call) => call.name).join(", ");
        console.log(`    step ${step.index + 1}: ${names}`);
      },
    });

    const graded = await gradeChecks(instance.checks, { transcript, finalState });
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
    });

    if (!options.quiet) {
      const percent = (graded.fraction * 100).toFixed(0).padStart(3);
      console.log(
        `  ${instance.itemId.padEnd(30)} ${percent}%  ${(graded.fraction * points).toFixed(2)}/${points}  ${transcript.endedBecause}`,
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

  const seed = args.flags.get("seed") ?? PUBLIC_DATASET_SEED;
  const instances = selectInstances(seed, args.flags.get("items"));
  const modelSpec = args.flags.get("model") ?? "oracle";
  const { adapter, measures } = buildAdapter(modelSpec);
  const maxTokensRaw = args.flags.get("max-tokens");
  const maxTokens = maxTokensRaw === undefined ? undefined : Number(maxTokensRaw);
  if (maxTokens !== undefined && (!Number.isFinite(maxTokens) || maxTokens <= 0)) {
    fail(`--max-tokens expects a positive number, got "${maxTokensRaw}"`);
  }
  const quiet = args.flags.has("quiet");

  console.log(`\nESAC-AG: ${instances.length} of ${TOTAL_ITEMS} items, model ${adapter.id}`);
  console.log(`status: ${ESAC_STATUS}`);
  if (!measures) {
    console.log("NOTE: the oracle adapter exercises the harness. It does not measure a model.\n");
  } else {
    console.log(`decoding: temperature ${DECODING.temperature}, cap ${maxTokens ?? OUTPUT_LIMITS.modelTokens} tokens\n`);
  }

  const started = Date.now();
  const outcomes = await runInstances(instances, adapter, {
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    quiet,
  });

  const report = scoreRun({
    items: outcomes,
    model: adapter.id,
    datasetSeedFingerprint: seedFingerprint(seed),
    durationMs: Date.now() - started,
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
 *  4. a run over a partially implemented suite is INCOMPLETE rather than a score.
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

  const outcomes = await runInstances(instances, oracle, { quiet: true });
  const report = scoreRun({
    items: outcomes,
    model: "oracle",
    datasetSeedFingerprint: seedFingerprint(PUBLIC_DATASET_SEED),
    durationMs: 0,
  });

  const problems: string[] = [];

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
  esac version                               print the implementation version and canary

run options:
  --model <spec>     "oracle" (harness self-test) or "<baseUrl>|<model>|<envVar>"
  --items <list>     comma-separated item ids or category ids
  --seed <s>         dataset seed (default: ${PUBLIC_DATASET_SEED})
  --max-tokens <n>   output cap for the model under test (default ${OUTPUT_LIMITS.modelTokens})
  --json <path>      write the full report as JSON
  --verbose          include per-check detail in the report
  --quiet            suppress the per-item progress tally

Notes:
  This build is not a benchmark. Six of the seven categories have no items, so a full run is
  reported as INCOMPLETE and no comparable ESAC-AG score can exist. The specification, not this
  repository, defines what the suite is: see EcoWestern/ESAC.
`;
}

async function main(): Promise<void> {
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
