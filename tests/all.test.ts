/**
 * ESAC-AG test suite.
 *
 * These tests assert the properties the suite's claims depend on, not merely that the code runs.
 * Roughly in order of importance:
 *
 *  1. The bank matches the specification: seven categories, 70 capability points, a 5-point
 *     modifier, and items only where a category claims to be implemented.
 *  2. Instance identity depends on the dataset seed and the item id and on nothing else.
 *  3. The mock environment behaves as a deterministic state machine, including refusing to
 *     escape its own root.
 *  4. The harness enforces the step budget, retries infrastructure failure, and scores model
 *     failure instead of retrying it.
 *  5. Every item's grader accepts its own expected call and rejects both the plausible sibling
 *     tool and the wrong target, which is what makes the distractors real.
 *  6. A run over a partially implemented suite is INCOMPLETE rather than a score.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  CAPABILITY_POINTS,
  CATEGORIES,
  EFFICIENCY_POINTS,
  ITEM_COUNTS,
  TOTAL_ITEMS,
  TOTAL_POINTS,
  itemPointsFor,
  validateDistribution,
} from "../src/categories.ts";
import { ALL_ITEMS, instantiateAll, seedFingerprint, validateBank } from "../src/registry.ts";
import { deriveSeed, fnv1a, makeRng } from "../src/rng.ts";
import { MockFilesystem, normalisePath } from "../src/env/filesystem.ts";
import { MockApi } from "../src/env/api.ts";
import { runShellCommand } from "../src/env/shell.ts";
import { FILESYSTEM_TOOLS, MockEnvironment } from "../src/env/tools.ts";
import { gradeChecks, gradeStateDiff, gradeToolCallExact } from "../src/graders.ts";
import { buildSystemPrompt, runTask } from "../src/runner.ts";
import { renderReport, scoreRun, type ItemOutcome } from "../src/score.ts";
import { createHttpAgent, createOracleAgent } from "../src/adapters.ts";
import { CONSOLE_OPERATIONS } from "../src/items/toolcall.ts";
import { InfrastructureError, ModelTimeoutError } from "../src/types.ts";
import { PUBLIC_DATASET_SEED, STEP_BUDGET } from "../src/version.ts";
import type {
  AgentAdapter,
  Check,
  EnvSnapshot,
  GradeContext,
  Instance,
  ModelRequest,
  ModelTurn,
  ToolCall,
  Transcript,
} from "../src/types.ts";

const SEED = PUBLIC_DATASET_SEED;
const INSTANCES = instantiateAll(SEED);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function instanceOf(itemId: string): Instance {
  const instance = INSTANCES.find((candidate) => candidate.itemId === itemId);
  assert.ok(instance, `no instance for ${itemId}`);
  return instance;
}

/** The call an item expects first, read from its own grader rather than duplicated here. */
function expectedCall(instance: Instance): ToolCall | null {
  for (const check of instance.checks) {
    if (check.grader.type === "toolcall-exact") {
      return { name: check.grader.tool, args: check.grader.args };
    }
  }
  return null;
}

const EMPTY_STATE: EnvSnapshot = { files: {}, api: {} };

function transcriptWith(calls: readonly ToolCall[]): Transcript {
  return {
    steps:
      calls.length === 0
        ? []
        : [
            {
              index: 0,
              text: "",
              calls,
              observations: calls.map(() => ({ ok: true, output: "" })),
            },
          ],
    finalText: "",
    endedBecause: "final",
    promptTokens: 0,
    completionTokens: 0,
    redundantCalls: 0,
  };
}

function contextFor(calls: readonly ToolCall[], finalState: EnvSnapshot = EMPTY_STATE): GradeContext {
  return { transcript: transcriptWith(calls), finalState };
}

/** An adapter whose behaviour is written in the test. */
function scripted(
  respond: (request: ModelRequest, turn: number) => ModelTurn | Promise<ModelTurn>,
): AgentAdapter {
  let turn = 0;
  return {
    id: "scripted",
    async complete(request: ModelRequest): Promise<ModelTurn> {
      // Count the attempt before running the script, so a script that throws still advances:
      // otherwise a retry would replay the same failing turn for ever.
      const current = turn;
      turn++;
      return respond(request, current);
    },
  };
}

function turn(calls: readonly ToolCall[]): ModelTurn {
  return { text: "", calls, finishReason: "tool_calls", promptTokens: 1, completionTokens: 1 };
}

const noSleep = async (): Promise<void> => undefined;

function oracleFor(instances: readonly Instance[]): ReturnType<typeof createOracleAgent> {
  const oracle = createOracleAgent();
  for (const instance of instances) {
    const call = expectedCall(instance);
    if (call) oracle.key.set(instance.brief, call);
  }
  return oracle;
}

// ===========================================================================
// 1. The bank and the specification
// ===========================================================================

test("the declared distribution matches the specification", () => {
  validateDistribution();
  assert.equal(CAPABILITY_POINTS, 70);
  assert.equal(EFFICIENCY_POINTS, 5);
  assert.equal(TOTAL_POINTS, 75);
  assert.equal(CATEGORIES.length, 7);
  assert.equal(TOTAL_ITEMS, 22);
});

test("the bank has items only where a category is implemented, in the declared counts", () => {
  validateBank();
  for (const category of CATEGORIES) {
    const count = ALL_ITEMS.filter((item) => item.category === category.id).length;
    assert.equal(count, category.implemented ? ITEM_COUNTS[category.id] : 0, category.id);
  }
});

test("each item of a category is worth the category allocation divided by its item count", () => {
  assert.equal(itemPointsFor("toolcall"), 2);
  for (const category of CATEGORIES) {
    const points = itemPointsFor(category.id) * ITEM_COUNTS[category.id];
    assert.equal(points, category.points, category.id);
  }
});

test("the tool-call category carries five items of two points", () => {
  const items = ALL_ITEMS.filter((item) => item.category === "toolcall");
  assert.equal(items.length, 5);
  assert.equal(items.length * itemPointsFor("toolcall"), 10);
});

test("every item carries a step budget inside the range the specification fixes", () => {
  for (const instance of INSTANCES) {
    assert.ok(
      instance.maxSteps >= STEP_BUDGET.min && instance.maxSteps <= STEP_BUDGET.max,
      `${instance.itemId} has a budget of ${instance.maxSteps}`,
    );
  }
});

// ===========================================================================
// 2. Determinism and instance identity
// ===========================================================================

test("generators are deterministic for a fixed dataset seed", () => {
  const first = instantiateAll(SEED);
  const second = instantiateAll(SEED);
  assert.equal(first.length, second.length);
  first.forEach((instance, index) => {
    assert.equal(instance.brief, second[index]!.brief);
    assert.equal(instance.fingerprint, second[index]!.fingerprint);
  });
});

test("instance seeds depend only on the dataset seed and the item id", () => {
  for (const instance of INSTANCES) {
    assert.equal(instance.seed, fnv1a(`${SEED}:${instance.itemId}`));
    assert.equal(instance.seed, deriveSeed(SEED, instance.itemId));
  }
});

test("a different dataset seed produces different instances", () => {
  const other = instantiateAll("esac-ag-test-other");
  const changed = INSTANCES.filter(
    (instance) => other.find((candidate) => candidate.itemId === instance.itemId)?.fingerprint !== instance.fingerprint,
  );
  assert.ok(changed.length >= 4, `only ${changed.length} of ${INSTANCES.length} instances changed`);
});

test("the seed fingerprint is stable, short, and does not contain the seed", () => {
  const fingerprint = seedFingerprint(SEED);
  assert.match(fingerprint, /^[0-9a-f]{8}$/);
  assert.equal(fingerprint, seedFingerprint(SEED));
  assert.notEqual(fingerprint, seedFingerprint("esac-ag-test-other"));
  assert.ok(!fingerprint.includes(SEED));
});

test("the rng is reproducible, bounded, and honest about empty input", () => {
  const a = makeRng(12345);
  const b = makeRng(12345);
  for (let i = 0; i < 50; i++) assert.equal(a.next(), b.next());

  const rng = makeRng(7);
  for (let i = 0; i < 200; i++) {
    const value = rng.int(5, 9);
    assert.ok(value >= 5 && value < 9, `int() produced ${value}`);
  }
  assert.deepEqual(makeRng(3).shuffle([1, 2, 3, 4, 5]), makeRng(3).shuffle([1, 2, 3, 4, 5]));
  assert.equal(makeRng(3).sample([1, 2, 3], 2).length, 2);
  assert.throws(() => makeRng(1).pick([]), /empty list/);
  assert.throws(() => makeRng(1).int(4, 4), /non-empty range/);
});

// ===========================================================================
// 3. The mock environment
// ===========================================================================

test("paths are normalised, and cannot leave the root", () => {
  assert.deepEqual(normalisePath("./a/b.txt"), { ok: true, path: "a/b.txt" });
  assert.deepEqual(normalisePath("/a//b"), { ok: true, path: "a/b" });
  assert.deepEqual(normalisePath("a\\b"), { ok: true, path: "a/b" });
  assert.equal(normalisePath("").ok, false);
  assert.equal(normalisePath("   ").ok, false);
  assert.equal(normalisePath("../escape").ok, false);
  assert.equal(normalisePath("a/../../escape").ok, false);
});

test("the filesystem reads, writes, appends, moves, and removes", () => {
  const fs = new MockFilesystem({ "notes/a.txt": "one" });
  assert.equal(fs.read("notes/a.txt"), "one");
  assert.equal(fs.read("./notes/a.txt"), "one");
  assert.equal(fs.read("/notes/a.txt"), "one");

  assert.equal(fs.write("notes/b.txt", "two"), true);
  assert.equal(fs.append("notes/b.txt", " and a half"), true);
  assert.equal(fs.read("notes/b.txt"), "two and a half");

  assert.deepEqual(fs.list("notes"), ["a.txt", "b.txt"]);
  assert.deepEqual(fs.list(""), ["notes/"]);

  assert.equal(fs.move("notes/b.txt", "notes/c.txt"), true);
  assert.equal(fs.read("notes/b.txt"), null);
  assert.equal(fs.read("notes/c.txt"), "two and a half");

  assert.equal(fs.remove("notes"), true);
  assert.deepEqual(fs.paths(), []);
  assert.equal(fs.remove("nothing"), false);
  assert.equal(fs.write("../escape", "no"), false);
});

test("a snapshot is ordered, so two identical states compare equal", () => {
  const fs = new MockFilesystem({ "b.txt": "2", "a.txt": "1" });
  assert.deepEqual(Object.keys(fs.snapshot()), ["a.txt", "b.txt"]);
  assert.deepEqual(fs.snapshot(), new MockFilesystem({ "a.txt": "1", "b.txt": "2" }).snapshot());
});

test("the shell runs over the filesystem and reports failures as exit codes", () => {
  const fs = new MockFilesystem({ "log.txt": "alpha beta\ngamma\n" });
  assert.equal(runShellCommand(fs, "cat log.txt").stdout, "alpha beta\ngamma\n");
  assert.equal(runShellCommand(fs, "ls").stdout, "log.txt\n");
  assert.equal(runShellCommand(fs, "wc log.txt").exitCode, 0);
  assert.equal(runShellCommand(fs, "write out.txt hello there").exitCode, 0);
  assert.equal(fs.read("out.txt"), "hello there");
  assert.equal(runShellCommand(fs, "append out.txt !").exitCode, 0);
  assert.equal(fs.read("out.txt"), "hello there!");
  assert.equal(runShellCommand(fs, "mv out.txt moved.txt").exitCode, 0);
  assert.equal(fs.read("moved.txt"), "hello there!");
  assert.equal(runShellCommand(fs, "rm moved.txt").exitCode, 0);
  assert.equal(runShellCommand(fs, "cat missing.txt").exitCode, 1);
  assert.equal(runShellCommand(fs, "nonsense").exitCode, 1);
  assert.equal(runShellCommand(fs, "   ").exitCode, 1);
});

test("the mock service refuses what cannot be done, distinctly", () => {
  const api = new MockApi(CONSOLE_OPERATIONS, {
    orders: { "1234": { id: "1234", status: "placed", total: 10, refunded: 0 } },
  });

  assert.match(api.call("orders.explode", {}).output, /no such operation/);
  assert.match(api.call("orders.cancel", { orderId: "1234" }).output, /needs a non-empty "reason"/);
  assert.match(api.call("orders.cancel", { orderId: "9999", reason: "x" }).output, /no such order/);

  assert.equal(api.call("orders.cancel", { orderId: "1234", reason: "changed mind" }).ok, true);
  assert.match(api.call("orders.cancel", { orderId: "1234", reason: "again" }).output, /already cancelled/);

  assert.equal(api.call("orders.refund", { orderId: "1234", amount: "12.50" }).ok, true);
  assert.equal(api.call("orders.refund", { orderId: "1234", amount: 5 }).ok, true);
  assert.match(api.call("orders.refund", { orderId: "1234", amount: -1 }).output, /positive number/);

  assert.match(api.call("mail.send", { to: "nobody", subject: "s", body: "b" }).output, /not an address/);
  assert.equal(api.call("mail.send", { to: "a@example.com", subject: "s", body: "b" }).ok, true);
});

test("the service state is a deterministic snapshot", () => {
  const api = new MockApi(CONSOLE_OPERATIONS, {
    orders: { "1": { id: "1", status: "placed", total: 10, refunded: 0 } },
  });

  api.call("orders.refund", { orderId: "1", amount: 2 });
  api.call("mail.send", { to: "a@example.com", subject: "s", body: "b" });

  const snapshot = api.snapshot() as {
    outbox: unknown[];
    orders: Record<string, Record<string, unknown>>;
  };
  assert.equal(snapshot.orders["1"]?.["refunded"], 2);
  assert.deepEqual(snapshot.outbox, [{ to: "a@example.com", subject: "s", body: "b" }]);

  // The same state has to serialise the same way twice, or a state diff is not a grader.
  assert.deepEqual(api.snapshot(), api.snapshot());

  // An operation on a resource that does not exist changes nothing.
  assert.equal(api.call("orders.refund", { orderId: "404", amount: 1 }).ok, false);
});

test("the environment offers the filesystem, the shell, and one tool per operation", () => {
  const instance = instanceOf("toolcall.orders-cancel");
  const environment = new MockEnvironment({
    initial: instance.initial,
    operations: instance.operations,
    maxSteps: instance.maxSteps,
  });

  const names = environment.definitions.map((tool) => tool.name);
  for (const tool of FILESYSTEM_TOOLS) assert.ok(names.includes(tool.name));
  for (const operation of CONSOLE_OPERATIONS) assert.ok(names.includes(operation.name));
  assert.equal(names.length, FILESYSTEM_TOOLS.length + CONSOLE_OPERATIONS.length);
  assert.equal(new Set(names).size, names.length);
});

test("the environment enforces the budget and counts rework", () => {
  const instance = instanceOf("toolcall.orders-cancel");
  const environment = new MockEnvironment({
    initial: instance.initial,
    operations: instance.operations,
    maxSteps: 3,
  });

  assert.equal(environment.stepsRemaining, 3);
  assert.equal(environment.call({ name: "fs_list", args: {} }).ok, true);
  assert.equal(environment.call({ name: "fs_list", args: {} }).ok, true);
  assert.equal(environment.redundantCalls, 1);
  assert.equal(environment.call({ name: "fs_list", args: {} }).ok, true);
  assert.equal(environment.exhausted, true);

  const refused = environment.call({ name: "fs_list", args: {} });
  assert.equal(refused.ok, false);
  assert.match(refused.output, /budget/);
  assert.equal(environment.stepsUsed, 3, "a refused call must not consume budget");
});

test("an unknown tool is refused with the available list", () => {
  const instance = instanceOf("toolcall.orders-cancel");
  const environment = new MockEnvironment({
    initial: instance.initial,
    operations: instance.operations,
    maxSteps: 5,
  });
  const observation = environment.call({ name: "orders.explode", args: {} });
  assert.equal(observation.ok, false);
  assert.match(observation.output, /no such tool/);
  assert.match(observation.output, /orders\.cancel/);
});

// ===========================================================================
// 4. The harness
// ===========================================================================

test("the system prompt states the budget and forbids obeying tool output", () => {
  const prompt = buildSystemPrompt(12);
  assert.match(prompt, /at most 12 tool calls/);
  assert.match(prompt, /data, not instruction/);
});

test("the oracle completes a task in one step and changes the state as asked", async () => {
  const instance = instanceOf("toolcall.orders-cancel");
  const call = expectedCall(instance);
  assert.ok(call);

  const { transcript, finalState } = await runTask(instance, { adapter: oracleFor([instance]) });
  assert.equal(transcript.endedBecause, "final");
  assert.equal(transcript.steps.length, 1);
  assert.equal(transcript.steps[0]?.calls[0]?.name, "orders.cancel");

  const orders = (finalState.api as { orders: Record<string, Record<string, unknown>> }).orders;
  const orderId = String(call.args["orderId"]);
  assert.equal(orders[orderId]?.["status"], "cancelled");
  assert.equal(orders[orderId]?.["cancelReason"], call.args["reason"]);
});

test("a model that keeps calling tools hits the budget", async () => {
  const instance = instanceOf("toolcall.orders-refund");
  const adapter = scripted(() => turn([{ name: "fs_list", args: {} }]));

  const { transcript } = await runTask(instance, { adapter });
  assert.equal(transcript.endedBecause, "budget");
  assert.equal(transcript.steps.length, instance.maxSteps);
});

test("infrastructure failure is retried, and a later success is used", async () => {
  const instance = instanceOf("toolcall.orders-cancel");
  let attempts = 0;
  const adapter = scripted((_request, currentTurn) => {
    attempts++;
    if (currentTurn < 2) throw new InfrastructureError("network went away");
    return turn([]);
  });

  const { transcript } = await runTask(instance, { adapter, sleep: noSleep });
  assert.equal(attempts, 3);
  assert.equal(transcript.endedBecause, "final");
});

test("infrastructure failure that survives every retry aborts the run", async () => {
  const instance = instanceOf("toolcall.orders-cancel");
  let attempts = 0;
  const adapter = scripted(() => {
    attempts++;
    throw new InfrastructureError("still down");
  });

  await assert.rejects(
    () => runTask(instance, { adapter, sleep: noSleep }),
    (error: unknown) => error instanceof InfrastructureError,
  );
  assert.equal(attempts, 5, "the configured number of attempts");
});

test("a model failure is scored, not retried, and its tokens are carried", async () => {
  const instance = instanceOf("toolcall.orders-cancel");
  let attempts = 0;
  const adapter = scripted(() => {
    attempts++;
    throw new ModelTimeoutError("too slow", 120, 34);
  });

  const { transcript } = await runTask(instance, { adapter, sleep: noSleep });
  assert.equal(attempts, 1, "a model failure must not be retried");
  assert.equal(transcript.endedBecause, "model-failure");
  assert.equal(transcript.promptTokens, 120);
  assert.equal(transcript.completionTokens, 34);
});

// ===========================================================================
// 5. Graders
// ===========================================================================

test("exact match on the first call accepts the expected call", () => {
  const result = gradeToolCallExact(
    "orders.cancel",
    { orderId: "4471", reason: "customer changed their mind" },
    contextFor([{ name: "orders.cancel", args: { orderId: 4471, reason: "Customer Changed  Their Mind" } }]),
  );
  assert.equal(result.fraction, 1, result.detail);
});

test("exact match tolerates numeric strings and typed numbers", () => {
  const asText = gradeToolCallExact(
    "orders.refund",
    { orderId: "5120", amount: 42.5 },
    contextFor([{ name: "orders.refund", args: { orderId: "5120", amount: "42.50" } }]),
  );
  assert.equal(asText.fraction, 1, asText.detail);

  const asNumber = gradeToolCallExact(
    "tickets.escalate",
    { ticketId: "812", tier: 2 },
    contextFor([{ name: "tickets.escalate", args: { ticketId: 812, tier: "2" } }]),
  );
  assert.equal(asNumber.fraction, 1, asNumber.detail);
});

test("exact match rejects the wrong tool, the wrong target, and no call", () => {
  const expected = { orderId: "4471", reason: "customer changed their mind" };

  const wrongTool = gradeToolCallExact(
    "orders.cancel",
    expected,
    contextFor([{ name: "orders.refund", args: expected }]),
  );
  assert.equal(wrongTool.fraction, 0);
  assert.match(wrongTool.detail, /orders\.refund/);

  const wrongTarget = gradeToolCallExact(
    "orders.cancel",
    expected,
    contextFor([{ name: "orders.cancel", args: { orderId: "9999", reason: expected.reason } }]),
  );
  assert.equal(wrongTarget.fraction, 0);
  assert.match(wrongTarget.detail, /orderId/);

  const missing = gradeToolCallExact(
    "orders.cancel",
    expected,
    contextFor([{ name: "orders.cancel", args: { orderId: "4471" } }]),
  );
  assert.equal(missing.fraction, 0);
  assert.match(missing.detail, /"reason" was missing/);

  const none = gradeToolCallExact("orders.cancel", expected, contextFor([]));
  assert.equal(none.fraction, 0);
  assert.match(none.detail, /no tool call/);
});

test("a state diff gives partial credit by resource", () => {
  const expected: EnvSnapshot = { files: { "a.txt": "1" }, api: { orders: { one: 1 } } };

  const full = gradeStateDiff(expected, {
    transcript: transcriptWith([]),
    finalState: { files: { "a.txt": "1" }, api: { orders: { one: 1 } } },
  });
  assert.equal(full.fraction, 1);

  const half = gradeStateDiff(expected, {
    transcript: transcriptWith([]),
    finalState: { files: { "a.txt": "1" }, api: { orders: { one: 2 } } },
  });
  assert.equal(half.fraction, 0.5);
  assert.match(half.detail, /1 of 2/);

  const nothing = gradeStateDiff(expected, {
    transcript: transcriptWith([]),
    finalState: EMPTY_STATE,
  });
  assert.equal(nothing.fraction, 0);

  const noExpectation = gradeStateDiff(EMPTY_STATE, {
    transcript: transcriptWith([]),
    finalState: EMPTY_STATE,
  });
  assert.equal(noExpectation.fraction, 1);
});

test("check weights are normalised within the item", () => {
  const checks: readonly Check[] = [
    { id: "call", weight: 3, grader: { type: "toolcall-exact", tool: "orders.cancel", args: { orderId: "1", reason: "r" } } },
    { id: "state", weight: 1, grader: { type: "state-diff", expected: { files: {}, api: { orders: {} } } } },
  ];
  const context = contextFor([{ name: "orders.cancel", args: { orderId: "1", reason: "r" } }]);
  const graded = gradeChecks(checks, context);
  assert.equal(graded.fraction, 0.75);
  assert.equal(graded.results.length, 2);
});

// ===========================================================================
// 6. Every item is answerable, and every distractor is wrong
// ===========================================================================

test("the oracle answers every item in the bank", async () => {
  const oracle = oracleFor(INSTANCES);
  for (const instance of INSTANCES) {
    const { transcript, finalState } = await runTask(instance, { adapter: oracle });
    const graded = gradeChecks(instance.checks, { transcript, finalState });
    assert.equal(graded.fraction, 1, `${instance.itemId}: ${graded.results[0]?.detail}`);
  }
});

/** The plausible wrong operation for each item: the thing this category exists to catch. */
const SIBLINGS: Readonly<Record<string, string>> = {
  "toolcall.orders-cancel": "orders.refund",
  "toolcall.orders-refund": "orders.cancel",
  "toolcall.tickets-escalate": "tickets.close",
  "toolcall.users-disable": "users.reset_password",
  "toolcall.mail-send": "mail.archive",
};

test("every item rejects its plausible sibling operation", () => {
  for (const instance of INSTANCES) {
    const call = expectedCall(instance);
    const sibling = SIBLINGS[instance.itemId];
    assert.ok(call && sibling, `${instance.itemId} needs a sibling mapping`);

    const graded = gradeChecks(
      instance.checks,
      contextFor([{ name: sibling, args: call.args }]),
    );
    assert.equal(graded.fraction, 0, `${instance.itemId} accepted ${sibling}`);
  }
});

test("every item rejects the same operation on the wrong target", () => {
  for (const instance of INSTANCES) {
    const call = expectedCall(instance);
    assert.ok(call);

    const targetKey = Object.keys(call.args).find((key) => key.endsWith("Id") || key === "to");
    assert.ok(targetKey, `${instance.itemId} has no target parameter to move`);

    const graded = gradeChecks(
      instance.checks,
      contextFor([{ name: call.name, args: { ...call.args, [targetKey]: "0000" } }]),
    );
    assert.equal(graded.fraction, 0, `${instance.itemId} accepted the wrong target`);
  }
});

test("every string parameter that is graded is quoted in the brief", () => {
  for (const instance of INSTANCES) {
    const call = expectedCall(instance);
    assert.ok(call);
    for (const [key, value] of Object.entries(call.args)) {
      if (typeof value !== "string" || value.length < 4) continue;
      assert.ok(
        instance.brief.includes(value),
        `${instance.itemId}: "${key}" is graded as "${value}" but the brief does not state it`,
      );
    }
  }
});

// ===========================================================================
// 7. Scoring and the report
// ===========================================================================

function perfectOutcomes(): readonly ItemOutcome[] {
  return INSTANCES.map((instance) => ({
    itemId: instance.itemId,
    category: instance.category,
    fraction: 1,
    checks: [],
    steps: 1,
    endedBecause: "final",
    redundantCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
  }));
}

test("a perfect run over the implemented category is INCOMPLETE, not a pass", () => {
  const report = scoreRun({
    items: perfectOutcomes(),
    model: "oracle",
    datasetSeedFingerprint: seedFingerprint(SEED),
    durationMs: 1,
  });

  assert.equal(report.total, 10);
  assert.equal(report.totalPossible, 75);
  assert.equal(report.normalized, 10 / 75);
  assert.equal(report.verdict, "incomplete");
  assert.equal(report.coverage.implementedPoints, 10);
  assert.equal(report.coverage.attemptedPoints, 10);

  const toolcall = report.categories.find((category) => category.id === "toolcall");
  assert.equal(toolcall?.awarded, 10);
  assert.equal(toolcall?.passed, true);
});

test("an unimplemented category is not attempted, so it is neither passed nor failed", () => {
  const report = scoreRun({
    items: perfectOutcomes(),
    model: "oracle",
    datasetSeedFingerprint: seedFingerprint(SEED),
    durationMs: 1,
  });

  for (const category of report.categories) {
    if (category.implemented) continue;
    assert.equal(category.itemCount, 0, category.id);
    assert.equal(category.awarded, 0, category.id);
    assert.equal(category.passed, true, category.id);
    assert.equal(category.normalized, 0, category.id);
  }
});

test("failing every item of the implemented category fails the gate, and the run stays incomplete", () => {
  const report = scoreRun({
    items: perfectOutcomes().map((outcome) => ({ ...outcome, fraction: 0 })),
    model: "oracle",
    datasetSeedFingerprint: seedFingerprint(SEED),
    durationMs: 1,
  });

  const toolcall = report.categories.find((category) => category.id === "toolcall");
  assert.equal(toolcall?.passed, false);
  assert.equal(report.passed, false);
  assert.equal(report.verdict, "incomplete");
});

test("the notes say what the number cannot be used for", () => {
  const report = scoreRun({
    items: perfectOutcomes(),
    model: "oracle",
    datasetSeedFingerprint: seedFingerprint(SEED),
    durationMs: 1,
  });

  const notes = report.notes.join("\n");
  assert.match(notes, /1 of 7 categories/);
  assert.match(notes, /INCOMPLETE/);
  assert.match(notes, /not a comparable ESAC-AG score/);
  assert.match(notes, /efficiency modifier/);
  assert.match(notes, /Nothing produced by this build is an ESAC-AG score/);
  assert.ok(report.efficiency.scored === false);
});

test("the report renders without throwing, and clamps its bars", () => {
  const report = scoreRun({
    items: perfectOutcomes(),
    model: "oracle",
    datasetSeedFingerprint: seedFingerprint(SEED),
    durationMs: 1,
  });

  assert.match(renderReport(report), /OVERALL/);

  // A renderer is the last place a wrong number should become a crash: a category above 100
  // percent overflows the bar, and an unclamped renderer fails on the number that explains it.
  const inflated = {
    ...report,
    categories: report.categories.map((category) => ({ ...category, normalized: 4 })),
  };
  const rendered = renderReport(inflated);
  assert.match(rendered, /OVERALL/);
  assert.match(rendered, /INCOMPLETE/);
});

// ===========================================================================
// 8. The HTTP adapter classifies failure
// ===========================================================================

test("the HTTP adapter treats a transport error as infrastructure and a truncation as a model failure", async () => {
  const instance = instanceOf("toolcall.orders-cancel");

  const broken = createHttpAgent({
    id: "broken",
    baseUrl: "https://example.invalid/v1",
    model: "m",
    fetchImpl: () => {
      throw new Error("socket hang up");
    },
  });
  await assert.rejects(
    () => runTask(instance, { adapter: broken, sleep: noSleep }),
    (error: unknown) => error instanceof InfrastructureError,
  );

  const truncated = createHttpAgent({
    id: "truncated",
    baseUrl: "https://example.invalid/v1",
    model: "m",
    fetchImpl: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: 90 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  const { transcript } = await runTask(instance, { adapter: truncated, sleep: noSleep });
  assert.equal(transcript.endedBecause, "model-failure");
  assert.equal(transcript.completionTokens, 90);
});

test("the HTTP adapter reads a tool call, and refuses a non-2xx status", async () => {
  const response = {
    choices: [
      {
        message: {
          content: "",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "orders.cancel", arguments: '{"orderId":"1","reason":"r"}' } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  };

  const adapter = createHttpAgent({
    id: "stub",
    baseUrl: "https://example.invalid/v1",
    model: "m",
    fetchImpl: async () =>
      new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const result = await adapter.complete({ messages: [{ role: "user", content: "x" }], tools: [], temperature: 0, maxTokens: 100 });
  assert.equal(result.calls[0]?.name, "orders.cancel");
  assert.deepEqual(result.calls[0]?.args, { orderId: "1", reason: "r" });
  assert.equal(result.promptTokens, 11);

  const failing = createHttpAgent({
    id: "failing",
    baseUrl: "https://example.invalid/v1",
    model: "m",
    fetchImpl: async () => new Response("nope", { status: 503 }),
  });
  await assert.rejects(
    () => failing.complete({ messages: [], tools: [], temperature: 0, maxTokens: 10 }),
    (error: unknown) => error instanceof InfrastructureError,
  );
});
