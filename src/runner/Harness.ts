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

        const session = new TestSession(adapter, scenario, this.reporter, this.options.uri);
        await session.execute();
      }
    }

    this.reporter.summary();
  }
}
