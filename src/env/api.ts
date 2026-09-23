/**
 * The mock service.
 *
 * A tiny engine for a stateful API: operations are declared as data, hold typed parameters, and
 * mutate the service state. The point of declaring them rather than dispatching on a string is
 * that the wrong operation has to be a plausible mistake. Cancelling an order and refunding it
 * are different tools with different effects on the same resource, and a model that picks the
 * sibling gets a defensible-looking answer and a different state.
 *
 * No network, no clock, no randomness. Two runs of the same task produce the same state, which
 * is what makes a state diff a grader rather than an opinion.
 */

import type { ApiOperation, ApiState, ToolObservation } from "../types.ts";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Sort keys so a state diff cannot be confused by insertion order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonical(source[key]);
    return out;
  }
  return value;
}

export class MockApi {
  private readonly operations: Map<string, ApiOperation>;
  private readonly state: Record<string, unknown>;

  constructor(operations: readonly ApiOperation[], initialState: ApiState = {}) {
    if (operations.length === 0) throw new Error("the mock service needs at least one operation");
    this.operations = new Map();
    for (const operation of operations) {
      if (this.operations.has(operation.name)) {
        throw new Error(`duplicate operation "${operation.name}"`);
      }
      this.operations.set(operation.name, operation);
    }
    this.state = clone(initialState) as Record<string, unknown>;
  }

  /** Operation names, sorted. */
  operationNames(): string[] {
    return [...this.operations.keys()].sort();
  }

  operation(name: string): ApiOperation | null {
    return this.operations.get(name) ?? null;
  }

  /**
   * Invoke an operation.
   *
   * Three ways to fail, and they are deliberately different messages: an operation that does not
   * exist, a missing required argument, and a failure inside the operation. A model that cannot
   * tell those apart cannot recover from any of them.
   */
  call(name: string, args: Readonly<Record<string, unknown>>): ToolObservation {
    const operation = this.operations.get(name);
    if (!operation) {
      return {
        ok: false,
        output: `no such operation "${name}". Available: ${this.operationNames().join(", ")}`,
      };
    }

    for (const key of operation.required) {
      const value = args[key];
      if (value === undefined || value === null || value === "") {
        return { ok: false, output: `${name} needs a non-empty "${key}"` };
      }
    }

    try {
      return operation.apply(this.state, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, output: `${name} failed: ${message}` };
    }
  }

  /** Canonical snapshot of the service state. */
  snapshot(): ApiState {
    return canonical(this.state) as ApiState;
  }
}
