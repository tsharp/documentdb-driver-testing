import { writeFileSync } from 'fs';
import type { Reporter } from './Reporter';

export interface MatrixTestResult {
  adapter: string;
  adapterVersion: string;
  scenario: string;
  test: string;
  status: 'pass' | 'fail' | 'skip';
  message?: string;
}

export interface MatrixRunFile {
  meta: {
    target: string;
    targetVersion: string;
    timestamp: string;
  };
  results: MatrixTestResult[];
}

/**
 * Writes a structured JSON file suitable for aggregation into the HTML matrix
 * report.  Each entry carries the adapter name extracted from the label so that
 * a single multi-adapter run produces one file that the generator can split by
 * column.
 *
 * Label format produced by TestSession: "[adapter] Scenario > Test"
 */
export class MatrixJsonReporter implements Reporter {
  private results: MatrixTestResult[] = [];

  constructor(
    private readonly outputPath: string,
    private readonly target: string,
    private readonly targetVersion: string,
    private readonly adapterVersions: Map<string, string>,
  ) {}

  pass(label: string): void {
    this.push(label, 'pass');
  }

  fail(label: string, err: Error): void {
    this.push(label, 'fail', err.message);
  }

  skip(label: string, reason: string): void {
    this.push(label, 'skip', reason);
  }

  summary(): void {
    const file: MatrixRunFile = {
      meta: {
        target: this.target,
        targetVersion: this.targetVersion,
        timestamp: new Date().toISOString(),
      },
      results: this.results,
    };

    writeFileSync(this.outputPath, JSON.stringify(file, null, 2), 'utf-8');
    console.error(`Matrix results written to ${this.outputPath}`);

    const failures = this.results.filter((r) => r.status === 'fail').length;
    if (failures > 0) {
      process.exitCode = 1;
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private push(label: string, status: 'pass' | 'fail' | 'skip', message?: string): void {
    const parsed = this.parseLabel(label);
    this.results.push({
      adapter: parsed.adapter,
      adapterVersion: this.adapterVersions.get(parsed.adapter) ?? 'unknown',
      scenario: parsed.scenario,
      test: parsed.test,
      status,
      ...(message !== undefined ? { message } : {}),
    });
  }

  /**
   * "[adapter] Scenario Description > Test Description"
   *  → { adapter, scenario, test }
   */
  private parseLabel(label: string): { adapter: string; scenario: string; test: string } {
    const m = /^\[([^\]]+)\]\s+(.+?)\s+>\s+(.+)$/.exec(label);
    if (m) {
      return { adapter: m[1], scenario: m[2], test: m[3] };
    }
    return { adapter: 'unknown', scenario: label, test: label };
  }
}
