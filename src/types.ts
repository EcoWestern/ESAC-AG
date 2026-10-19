/**
 * Core contracts.
 *
 * Everything the environment, the harness, the graders, and the scorer have to agree on. Kept
 * in one file on purpose: this suite has more moving parts than a single-turn benchmark, and the
 * cheapest way to keep them honest is to make the shapes they exchange visible in one place.
 *
 * Written for Node's strip-only TypeScript: no enums, no namespaces, no parameter properties.
 */

import type { CategoryId } from "./categories.ts";
import type { Rng } from "./rng.ts";

export type Split = "public" | "heldout";

// ---------------------------------------------------------------------------
// The mock environment
// ---------------------------------------------------------------------------

/** Files in the toy filesystem, keyed by normalised path. */
export type EnvFiles = Readonly<Record<string, string>>;

/** The mock service's state. Opaque to the harness: only operations read it. */
export type ApiState = Readonly<Record<string, unknown>>;

/**
 * A canonical snapshot of the environment.
 *
 * This is what a state diff compares, so it has to be total and ordered: every file, every
 * service resource, in a stable order. A snapshot that varies between two identical runs would
 * make the grader nondeterministic, which is the one thing the suite cannot afford.
 */
export interface EnvSnapshot {
  readonly files: EnvFiles;
  readonly api: ApiState;
}

/** One tool invocation, as the model asked for it. */
export interface ToolCall {
  /**
   * Provider-assigned identifier, when the protocol has one.
   *
   * Carried rather than invented by the runner, because a tool result that does not match the
   * call it answers is rejected by strict endpoints.
   */
  readonly id?: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** One tool, as the model is offered it. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments. */
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** What the environment answered. */
export interface ToolObservation {
  readonly ok: boolean;
  readonly output: string;
  readonly data?: unknown;
}

/**
 * One operation on the mock service.
 *
 * The wrong operation is meant to be a plausible mistake rather than a random one, which is why
 * operations are declared as a set with typed parameters instead of being handled by a generic
 * dispatch. Mutating `state` in place is the intended interface: the environment is single
 * threaded and the state is cloned between runs.
 */
export interface ApiOperation {
  readonly name: string;
  readonly description: string;
  /** Argument names that must be present and non-empty. */
  readonly required: readonly string[];
  /** Argument name to a human readable type, used to build the tool schema. */
  readonly parameters: Readonly<Record<string, string>>;
  readonly apply: (
    state: Record<string, unknown>,
    args: Readonly<Record<string, unknown>>,
  ) => ToolObservation;
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

/** One turn: what the model said, what it called, and what came back. */
export interface Step {
  readonly index: number;
  readonly text: string;
  readonly calls: readonly ToolCall[];
  readonly observations: readonly ToolObservation[];
}

/**
 * Why a run stopped.
 *
 * `budget` is a failure, not a neutral ending: the task was not completed inside the cap. The
 * distinction is recorded rather than inferred later, because a report that cannot say why a run
 * stopped cannot be audited.
 */
export type EndedBecause = "final" | "budget" | "model-failure" | "infrastructure";

export interface Transcript {
  readonly steps: readonly Step[];
  readonly finalText: string;
  readonly endedBecause: EndedBecause;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /**
   * Calls identical to an earlier call, which is the observable half of rework. The efficiency
   * modifier uses it; nothing else does.
   */
  readonly redundantCalls: number;
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

export interface GraderResult {
  readonly fraction: number;
  readonly detail: string;
}

/**
 * Deterministic graders only. The judge arrives with the category that needs one.
 *
 * `toolcall-exact` is the first call matching in tool and in the parameters that matter.
 * `state-diff` is the final environment matching the goal state, with partial credit by
 * resource, and an optional list of things that must no longer exist.
 * `hidden-tests` runs the artifact the model produced, against inputs it never saw.
 * `final-text-contains` looks for a phrase in the final reply, which is the bluntest grader here
 * and is only ever used with a small weight.
 */
export type Grader =
  | {
      readonly type: "toolcall-exact";
      readonly tool: string;
      readonly args: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "state-diff";
      readonly expected: EnvSnapshot;
      /**
       * Resources that must not exist when the run is over.
       *
       * A filesystem path, with a trailing slash meaning "and nothing under this directory", or a
       * service path such as `api/users/ada/admin`. Without it, a goal state can express what to
       * create or change but not what must be absent, and half of what these items measure is the
       * absence of something: an admin flag that was never set, a message that was never sent.
       */
      readonly absent?: readonly string[];
      /**
       * File paths whose contents are compared with line endings and trailing whitespace
       * normalised.
       *
       * Used for files a human would read, where a trailing newline is not a mistake. It is
       * opt-in per file rather than global, because for generated artifacts an exact byte
       * comparison is the honest one.
       */
      readonly lenientText?: readonly string[];
    }
  | {
      readonly type: "hidden-tests";
      /** Path of the script to run, as it appears in the final filesystem. */
      readonly entry: string;
      readonly tests: readonly HiddenTest[];
    }
  | { readonly type: "final-text-contains"; readonly any: readonly string[] }
  /**
   * Rubric grading by the pinned judge model.
   *
   * The only grader this suite cannot evaluate offline. It is applied by the harness rather than
   * by `gradeChecks`, because judging is subject to the replication protocol and a grader that
   * quietly ran a judge once would break the 2x2 the specification fixes.
   */
  | { readonly type: "judge"; readonly rubric: Rubric };

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

/** One described point on a criterion's scale. Optional: a criterion may just state its meaning. */
export interface RubricLevel {
  readonly score: number;
  readonly label: string;
  readonly description: string;
}

export interface RubricCriterion {
  readonly id: string;
  readonly description: string;
  /** Relative weight within the rubric. Normalised by the scorer, never by the judge. */
  readonly weight: number;
  readonly levels?: readonly RubricLevel[];
}

/**
 * A fixed rubric.
 *
 * The id is a version: changing what a criterion means changes what a score means, so a change
 * here is a major-version change to the suite rather than an edit.
 */
export interface Rubric {
  readonly id: string;
  /** Injected into the judge prompt to state what the task was asking for. */
  readonly context: string;
  readonly criteria: readonly RubricCriterion[];
}

export interface JudgeInput {
  readonly rubric: Rubric;
  readonly taskPrompt: string;
  readonly response: string;
  /**
   * What the environment records about the run.
   *
   * Added here rather than carried over from ESAC-GI, because an agentic item needs criteria
   * about what the run *did*, and a judge that only sees the final reply has to take the model's
   * word for it. These lines are computed by the harness from the state before and after, so
   * "nothing was deleted" is a fact the judge is told rather than a claim it is asked to trust.
   */
  readonly facts: readonly string[];
}

export interface JudgeResponse {
  readonly scores: Readonly<Record<string, number>>;
  readonly raw: string;
}

/** Must be an open-weight, self-hostable model, pinned per release. */
export interface JudgeAdapter {
  readonly id: string;
  score(input: JudgeInput): Promise<JudgeResponse>;
}

/**
 * One hidden test: input on stdin, expected on stdout.
 *
 * Program-level rather than module-level, because it needs no import convention and no knowledge
 * of how the model organised its code, and because a script that reads stdin and prints a result
 * is the smallest artifact that can be specified unambiguously in prose.
 */
export interface HiddenTest {
  readonly name: string;
  readonly stdin: string;
  readonly expectedStdout: string;
}

export interface Check {
  readonly id: string;
  readonly weight: number;
  readonly grader: Grader;
}

export interface CheckResult {
  readonly id: string;
  readonly fraction: number;
  readonly detail: string;
}

/** Everything a grader is allowed to look at. Deliberately not the model's reasoning. */
export interface GradeContext {
  readonly transcript: Transcript;
  readonly finalState: EnvSnapshot;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** What a generator produces: one concrete task and how to grade it. */
export interface Generated {
  /** The task, as the model sees it. */
  readonly brief: string;
  /** The environment the task starts in. */
  readonly initial: EnvSnapshot;
  /** The operations available, which are also the tools offered for the service. */
  readonly operations: readonly ApiOperation[];
  /** This task's cap on tool calls, inside the range the specification fixes. */
  readonly maxSteps: number;
  /** Authored efficiency envelope for this task's local 1 to 6 scale. */
  readonly efficiency?: EfficiencyEnvelope;
  /**
   * Whether this task's environment offers code execution.
   *
   * Off unless the item needs it, so the two categories that run generated code are the only
   * ones that can reach the sandbox, and every other task is graded without executing anything.
   */
  readonly execution?: boolean;
  readonly checks: readonly Check[];
  /** The expected final answer, where one exists. Never sent to the model. */
  readonly reference?: string;
  /**
   * A solution that passes the item's own hidden tests.
   *
   * Kept in the generator rather than in the environment, and run by the test suite, because an
   * item whose tests nothing can pass is an item that measures nothing. It is never sent to the
   * model and never used in grading.
   */
  readonly referenceSolution?: string;
}

/**
 * The task-specific envelope used by the 5-point efficiency modifier.
 *
 * Actions are tool calls. Tokens use the model's prompt and completion usage. The reference
 * values are not a secret answer: they are the authored description of a clean route, while the
 * maximum values are the point at which rework has become material.
 */
export interface EfficiencyEnvelope {
  readonly referenceActions: number;
  readonly maximumActions: number;
  readonly referenceTokens: number;
  readonly maximumTokens: number;
}

export interface Instance extends Generated {
  readonly itemId: string;
  readonly category: CategoryId;
  readonly seed: number;
  readonly fingerprint: string;
  /**
   * True when any check needs the judge.
   *
   * Drives the replication protocol: a judge-graded task runs the model twice and each response
   * is judged twice. Declared on the instance rather than derived at the call site, so a run
   * cannot accidentally give a judged item the single run that deterministic items get.
   */
  readonly judgeGraded: boolean;
}

export interface ItemTemplate {
  readonly id: string;
  readonly category: CategoryId;
  /** What this item measures. Not sent to the model. */
  readonly measures: string;
  readonly generate: (rng: Rng, seed: number) => Generated;
}

// ---------------------------------------------------------------------------
// Model access
// ---------------------------------------------------------------------------

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
  readonly toolName?: string;
}

export interface ModelRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly temperature: number;
  readonly maxTokens: number;
}

export interface ModelTurn {
  readonly text: string;
  readonly calls: readonly ToolCall[];
  readonly finishReason: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface AgentAdapter {
  readonly id: string;
  complete(request: ModelRequest): Promise<ModelTurn>;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * `not-valid` is reserved for a run under a substituted judge, which cannot exist yet because
 * the judge-graded category is not implemented. It is in the type because a report shape that
 * cannot express the case is the shape that will hide it later.
 */
export type Verdict = "pass" | "fail" | "incomplete" | "not-valid";

export interface ItemRunResult {
  readonly itemId: string;
  readonly category: CategoryId;
  readonly points: number;
  readonly fraction: number;
  readonly awarded: number;
  readonly checks: readonly CheckResult[];
  readonly steps: number;
  readonly endedBecause: EndedBecause;
  readonly redundantCalls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly judgeGraded: boolean;
  /** Model runs performed: two for a judged item, one otherwise. */
  readonly modelRuns: number;
  /** Mean of the individual judgments, before any deterministic checks are combined in. */
  readonly judgeFraction: number | null;
}

export interface CategoryScore {
  readonly id: CategoryId;
  readonly name: string;
  /** The category's allocated points, from the specification. */
  readonly points: number;
  readonly awarded: number;
  readonly normalized: number;
  readonly itemCount: number;
  readonly implemented: boolean;
  readonly judgeGraded: boolean;
  /** A category with no items was not attempted, so it is neither passed nor failed. */
  readonly passed: boolean;
}

export interface EfficiencyScore {
  readonly points: number;
  readonly awarded: number;
  /** True when authored envelopes were applied to successful tasks. */
  readonly scored: boolean;
}

export interface RunReport {
  readonly suite: string;
  readonly implementationVersion: string;
  readonly versionTag: string;
  readonly fullName: string;
  readonly status: string;
  readonly datasetSeedFingerprint: string;
  readonly split: Split;
  readonly model: string;
  /** Model used as the judge, or null when the run contained no judge-graded items. */
  readonly judge: string | null;
  /**
   * Whether the judge was the model pinned for this release.
   *
   * Recorded rather than checked and discarded, because a substituted judge makes the judged
   * share of the score a different measurement, and a report that hides that is the report that
   * gets quoted.
   */
  readonly judgePinned: boolean;
  /** Share of the suite's points that depend on a judge. */
  readonly judgeGradedPoints: number;
  readonly items: readonly ItemRunResult[];
  readonly categories: readonly CategoryScore[];
  readonly total: number;
  readonly totalPossible: number;
  readonly normalized: number;
  readonly passed: boolean;
  readonly verdict: Verdict;
  readonly coverage: {
    /** Points belonging to categories that have items. */
    readonly implementedPoints: number;
    /** Points belonging to categories this run actually touched. */
    readonly attemptedPoints: number;
  };
  readonly efficiency: EfficiencyScore;
  readonly notes: readonly string[];
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Not the model's fault, and never scored.
 *
 * Transport failure, a non-2xx status, an unparseable body. Retried, and if it survives the
 * retries the run aborts rather than reporting an outage as a low score.
 */
export class InfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfrastructureError";
  }
}

/**
 * A model failure, and therefore scored.
 *
 * Token usage is carried because a timed-out or truncated call still costs money, and a run
 * report that quietly drops it understates the cost of the run.
 */
export class ModelTimeoutError extends Error {
  readonly promptTokens: number;
  readonly completionTokens: number;

  constructor(message: string, promptTokens = 0, completionTokens = 0) {
    super(message);
    this.name = "ModelTimeoutError";
    this.promptTokens = promptTokens;
    this.completionTokens = completionTokens;
  }
}

/**
 * The response hit the output cap without producing anything usable.
 *
 * Distinguished from an unparseable body because the causes and the fixes differ: this one says
 * the budget was too small for the model's reasoning, and retrying it reaches the same
 * conclusion, so it is not retried and it is not infrastructure.
 */
export class ModelTruncatedError extends Error {
  readonly promptTokens: number;
  readonly completionTokens: number;

  constructor(message: string, promptTokens = 0, completionTokens = 0) {
    super(message);
    this.name = "ModelTruncatedError";
    this.promptTokens = promptTokens;
    this.completionTokens = completionTokens;
  }
}
