import type { DriverAdapter } from '../protocol/DriverAdapter';
import type {
  ErrorOverride,
  ExpectedError,
  Operation,
  OperationResult,
  Scenario,
  TestCase,
} from '../protocol/types';
import type { Reporter } from '../reporters/Reporter';

export class TestSession {
  /**
   * Per-test-case context store. Keys are `$$varName`; values are the results
   * of operations that used `saveResultAs`. Cleared between test cases.
   */
  private store = new Map<string, unknown>();

  constructor(
    private readonly adapter: DriverAdapter,
    private readonly scenario: Scenario,
    private readonly reporter: Reporter,
    private readonly uri: string,
    private readonly target: string = 'unknown',
  ) {}

  /** Connect once, run all test cases in the scenario, then disconnect. */
  async execute(): Promise<void> {
    await this.adapter.connect(this.uri);
    try {
      for (const test of this.scenario.tests) {
        await this.runTest(test);
      }
    } finally {
      await this.adapter.disconnect();
    }
  }

  private async runTest(test: TestCase): Promise<void> {
    const label = `[${this.adapter.name}] ${this.scenario.description} > ${test.description}`;

    if (test.skipReason) {
      this.reporter.skip(label, test.skipReason);
      return;
    }

    this.store.clear();

    try {
      // ── Setup ────────────────────────────────────────────────────────────
      if (this.scenario.setup) {
        for (const op of this.scenario.setup) {
          const r = await this.adapter.runOperation(this.resolveRefs(op));
          if (r.error) {
            throw new Error(`Setup operation "${op.name}" failed: ${r.error.message}`);
          }
        }
      }

      // ── Operations ───────────────────────────────────────────────────────
      for (const op of test.operations) {
        const resolved = this.resolveRefs(op);
        const result = await this.adapter.runOperation(resolved);

        if (op.saveResultAs !== undefined) {
          this.store.set(`$$${op.saveResultAs}`, result.result);
        }

        if (op.expectError) {
          this.assertError(result, op.expectError, label, op.name);
        } else if (op.expectResult !== undefined) {
          if (result.error) {
            throw new Error(
              `Operation "${op.name}" unexpectedly failed: ${result.error.message}`,
            );
          }
          this.assertMatches(result.result, op.expectResult, `${label} > ${op.name}`);
        }
      }

      this.reporter.pass(label);
    } catch (err) {
      this.reporter.fail(label, err instanceof Error ? err : new Error(String(err)));
    } finally {
      // ── Teardown ─────────────────────────────────────────────────────────
      if (this.scenario.teardown) {
        for (const op of this.scenario.teardown) {
          await this.adapter.runOperation(this.resolveRefs(op)).catch(() => {});
        }
      }
      // Reset adapter state (open sessions, cursors) before the next test case.
      await this.adapter.cleanupTestState?.().catch(() => {});
    }
  }

  // ── Reference resolution ──────────────────────────────────────────────────

  private resolveRefs(op: Operation): Operation {
    return {
      ...op,
      arguments: op.arguments
        ? (this.resolveValue(op.arguments) as Record<string, unknown>)
        : undefined,
    };
  }

  private resolveValue(value: unknown): unknown {
    if (typeof value === 'string' && value.startsWith('$$')) {
      return this.store.get(value);
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.resolveValue(v));
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          this.resolveValue(v),
        ]),
      );
    }
    return value;
  }

  // ── Assertion helpers ─────────────────────────────────────────────────────

  private assertMatches(actual: unknown, expected: unknown, location: string): void {
    if (!this.matches(actual, expected)) {
      throw new Error(
        `Assertion failed at "${location}":\n` +
          `  expected: ${JSON.stringify(expected, null, 2)}\n` +
          `  actual:   ${JSON.stringify(actual, null, 2)}`,
      );
    }
  }

  /**
   * Recursive matcher.
   *
   * Special object forms:
   *   `{ $$exists: true|false }` — presence check
   *   `{ $$type: "string"|"number"|… }` — typeof check
   *   `{ hasField: "fieldName" }` — key presence on actual object
   *
   * Plain objects use **subset matching**: every key in `expected` must exist
   * in `actual` with a matching value; extra keys in `actual` are ignored.
   *
   * Primitive values use strict equality.
   */
  private matches(actual: unknown, expected: unknown): boolean {
    if (expected === null || typeof expected !== 'object') {
      return actual === expected;
    }

    const exp = expected as Record<string, unknown>;

    if ('$$exists' in exp) {
      const shouldExist = Boolean(exp['$$exists']);
      return shouldExist
        ? actual !== undefined && actual !== null
        : actual === undefined || actual === null;
    }
    if ('$$type' in exp) {
      return typeof actual === exp['$$type'];
    }
    if ('hasField' in exp) {
      const field = exp['hasField'] as string;
      return actual !== null && typeof actual === 'object' && field in (actual as object);
    }

    if (actual === null || typeof actual !== 'object') return false;
    const act = actual as Record<string, unknown>;
    return Object.entries(exp).every(([k, v]) => this.matches(act[k], v));
  }

  /**
   * Resolve the applicable override for the current adapter+target, using
   * specificity order: (adapter+target) > (adapter-only) > (target-only) > none.
   */
  private resolveErrorOverride(overrides: ErrorOverride[] | undefined): ErrorOverride | undefined {
    if (!overrides?.length) return undefined;
    const adapterName = this.adapter.name;
    const target = this.target;
    // Most specific: both adapter and target match
    const both = overrides.find(
      (o) => o.adapter !== undefined && o.target !== undefined &&
             o.adapter === adapterName && o.target === target,
    );
    if (both) return both;
    // Adapter-only match
    const byAdapter = overrides.find((o) => o.adapter !== undefined && o.target === undefined && o.adapter === adapterName);
    if (byAdapter) return byAdapter;
    // Target-only match
    const byTarget = overrides.find((o) => o.target !== undefined && o.adapter === undefined && o.target === target);
    return byTarget;
  }

  private assertError(
    result: OperationResult,
    expected: ExpectedError,
    label: string,
    opName: string,
  ): void {
    if (!result.error) {
      throw new Error(
        `Operation "${opName}" in "${label}" was expected to fail but succeeded`,
      );
    }
    const override = this.resolveErrorOverride(expected.overrides);
    const errorContains = override?.errorContains ?? expected.errorContains;
    const errorCode = override?.errorCode ?? expected.errorCode;
    if (errorContains && !result.error.message.includes(errorContains)) {
      throw new Error(
        `Expected error message to contain "${errorContains}" in "${label}", ` +
          `got: "${result.error.message}"`,
      );
    }
    if (errorCode !== undefined && result.error.code !== errorCode) {
      throw new Error(
        `Expected error code ${errorCode} in "${label}", got: ${result.error.code}`,
      );
    }
    if (expected.errorLabelsContain) {
      for (const lbl of expected.errorLabelsContain) {
        if (!result.error.labels?.includes(lbl)) {
          throw new Error(`Expected error label "${lbl}" to be present in "${label}"`);
        }
      }
    }
    if (expected.errorLabelsOmit) {
      for (const lbl of expected.errorLabelsOmit) {
        if (result.error.labels?.includes(lbl)) {
          throw new Error(`Expected error label "${lbl}" to be absent in "${label}"`);
        }
      }
    }
  }
}
