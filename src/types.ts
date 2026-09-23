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
 * Deterministic graders only, for now.
 *
 * `toolcall-exact` is the first call matching in tool and in the parameters that matter.
 * `state-diff` is the final environment matching the goal state, with partial credit by
 * resource. The judge, hidden-test, and comply-or-flag graders arrive with the categories that
 * need them; declaring them before they exist would be the kind of claim this repository is
 * supposed to avoid making.
 */
export type Grader =
  | {
      readonly type: "toolcall-exact";
      readonly tool: string;
      readonly args: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "state-diff"; readonly expected: EnvSnapshot };

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
  readonly checks: readonly Check[];
  /** The expected final answer, where one exists. Never sent to the model. */
  readonly reference?: string;
}

export interface Instance extends Generated {
  readonly itemId: string;
  readonly category: CategoryId;
  readonly seed: number;
  readonly fingerprint: string;
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
  /** False until each task's authored envelope exists and the normalisation is applied. */
  readonly scored: boolean;
}

export interface RunReport {
  readonly suite: string;
  readonly implementationVersion: string;
  readonly versionTag: string;
  readonly fullName: string;
  readonly status: string;
  readonly datasetSeedFingerprint: string;
  readonly model: string;
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
