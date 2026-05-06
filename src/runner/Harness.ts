import type { DriverAdapter } from '../protocol/DriverAdapter';
import type { Scenario } from '../protocol/types';
import type { Reporter } from '../reporters/Reporter';
import { TestSession } from './TestSession';
import { adapterMatchesRunOn, serverSatisfies } from './VersionMatrix';

export interface HarnessOptions {
  uri: string;
  /**
   * The server version string used for `minServerVersion` / `maxServerVersion`
   * gating. Defaults to `"999.0.0"` (runs everything) when not provided.
   * Pass the value returned by `db.admin().command({ buildInfo: 1 }).version`.
   */
  serverVersion?: string;
  /** Server target name (e.g. "mongodb", "documentdb"). Used for error overrides. */
  target?: string;
}

/** Extract the adapter name from a test label like "[nodejs-v6.x] scenario > test". */
function labelAdapter(label: string): string {
  const m = /^\[([^\]]+)\]/.exec(label);
  return m ? m[1] : label;
}

/**
 * Top-level orchestrator.
 *
 * For every (adapter × scenario) pair that satisfies the `runOn` and version
 * constraints, a `TestSession` is created and executed in sequence.
 */
export class Harness {
  private readonly serverVersion: string;

  constructor(
    private readonly adapters: DriverAdapter[],
    private readonly scenarios: Scenario[],
    private readonly reporter: Reporter,
    private readonly options: HarnessOptions,
  ) {
    this.serverVersion = options.serverVersion ?? '999.0.0';
  }

  async run(): Promise<void> {
    // Pre-count the number of test cases each adapter will actually run so
    // reporters can show accurate progress totals before any test starts.
    const adapterTotals = new Map<string, number>();
    const adapterDone   = new Map<string, number>();
    for (const adapter of this.adapters) {
      let total = 0;
      for (const scenario of this.scenarios) {
        if (
          !serverSatisfies(this.serverVersion, scenario.minServerVersion, scenario.maxServerVersion) ||
          !adapterMatchesRunOn(adapter, scenario.runOn, this.serverVersion)
        ) continue;
        total += scenario.tests.length;
      }
      adapterTotals.set(adapter.name, total);
      adapterDone.set(adapter.name, 0);
    }

    // Wrap reporter callbacks so we can inject testDone after every result.
    const originalPass = this.reporter.pass.bind(this.reporter);
    const originalFail = this.reporter.fail.bind(this.reporter);
    const originalSkip = this.reporter.skip.bind(this.reporter);

    const tick = (adapterName: string) => {
      const done  = (adapterDone.get(adapterName) ?? 0) + 1;
      const total = adapterTotals.get(adapterName) ?? 0;
      adapterDone.set(adapterName, done);
      this.reporter.testDone?.(adapterName, done, total);
    };

    this.reporter.pass = (label: string) => { originalPass(label); tick(labelAdapter(label)); };
    this.reporter.fail = (label: string, err: Error) => { originalFail(label, err); tick(labelAdapter(label)); };
    this.reporter.skip = (label: string, reason: string) => { originalSkip(label, reason); tick(labelAdapter(label)); };

    for (const scenario of this.scenarios) {
      if (
        !serverSatisfies(
          this.serverVersion,
          scenario.minServerVersion,
          scenario.maxServerVersion,
        )
      ) {
        this.reporter.skip(scenario.description, 'server version out of range');
        continue;
      }

      for (const adapter of this.adapters) {
        if (!adapterMatchesRunOn(adapter, scenario.runOn, this.serverVersion)) {
          this.reporter.skip(
            scenario.description,
            `adapter "${adapter.name}" excluded by runOn`,
          );
          continue;
        }

        // Signal beginAdapter the first time we encounter this adapter running a real test.
        if ((adapterDone.get(adapter.name) ?? 0) === 0 && !this._begunAdapters.has(adapter.name)) {
          this._begunAdapters.add(adapter.name);
          this.reporter.beginAdapter?.(adapter.name, adapterTotals.get(adapter.name) ?? 0);
        }

        const session = new TestSession(adapter, scenario, this.reporter, this.options.uri, this.options.target ?? 'unknown');
        await session.execute();
      }
    }

    // Restore original methods before summary so reporters behave normally.
    this.reporter.pass = originalPass;
    this.reporter.fail = originalFail;
    this.reporter.skip = originalSkip;

    this.reporter.summary();
  }

  private _begunAdapters = new Set<string>();
}
