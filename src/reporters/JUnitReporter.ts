import { writeFileSync } from 'fs';
import type { Reporter } from './Reporter';

interface TestResult {
  classname: string;
  name: string;
  status: 'pass' | 'fail' | 'skip';
  message?: string;
}

/**
 * Buffers results and writes a JUnit XML file on summary().
 *
 * Label format produced by TestSession: "[adapter] Scenario > Test"
 * Maps to:  classname="adapter.Scenario"  name="Test"
 *
 * The output path defaults to "test-results.xml" and can be overridden
 * by passing `outputPath` to the constructor.
 */
export class JUnitReporter implements Reporter {
  private results: TestResult[] = [];

  constructor(private readonly outputPath: string = 'test-results.xml') {}

  pass(label: string): void {
    this.results.push({ ...this.parseLabel(label), status: 'pass' });
  }

  fail(label: string, err: Error): void {
    this.results.push({ ...this.parseLabel(label), status: 'fail', message: err.message });
  }

  skip(label: string, reason: string): void {
    this.results.push({ ...this.parseLabel(label), status: 'skip', message: reason });
  }

  summary(): void {
    const total = this.results.length;
    const failures = this.results.filter((r) => r.status === 'fail').length;
    const skipped = this.results.filter((r) => r.status === 'skip').length;

    // Group by classname so we can emit one <testsuite> per adapter+scenario.
    const suites = new Map<string, TestResult[]>();
    for (const r of this.results) {
      const bucket = suites.get(r.classname) ?? [];
      bucket.push(r);
      suites.set(r.classname, bucket);
    }

    const suitesXml = [...suites.entries()]
      .map(([classname, tests]) => {
        const sFailures = tests.filter((t) => t.status === 'fail').length;
        const sSkipped = tests.filter((t) => t.status === 'skip').length;
        const cases = tests
          .map((t) => {
            const attrs = `name=${attr(t.name)} classname=${attr(classname)}`;
            if (t.status === 'fail') {
              return `      <testcase ${attrs}>\n        <failure message=${attr(t.message ?? '')}>${esc(t.message ?? '')}</failure>\n      </testcase>`;
            }
            if (t.status === 'skip') {
              return `      <testcase ${attrs}>\n        <skipped message=${attr(t.message ?? '')} />\n      </testcase>`;
            }
            return `      <testcase ${attrs} />`;
          })
          .join('\n');
        return (
          `    <testsuite name=${attr(classname)} tests="${tests.length}" failures="${sFailures}" skipped="${sSkipped}">\n` +
          cases +
          `\n    </testsuite>`
        );
      })
      .join('\n');

    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<testsuites name="driver-testing" tests="${total}" failures="${failures}" skipped="${skipped}">\n` +
      suitesXml +
      `\n</testsuites>\n`;

    writeFileSync(this.outputPath, xml, 'utf-8');
    console.error(`JUnit results written to ${this.outputPath}`);

    if (failures > 0) {
      process.exitCode = 1;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Parses "[adapter] Scenario Description > Test Description"
   * into { classname: "adapter.Scenario Description", name: "Test Description" }.
   * Falls back gracefully if the label doesn't match the expected shape.
   */
  private parseLabel(label: string): { classname: string; name: string } {
    const m = /^\[([^\]]+)\]\s+(.+?)\s+>\s+(.+)$/.exec(label);
    if (m) {
      return { classname: `${m[1]}.${m[2]}`, name: m[3] };
    }
    return { classname: 'unknown', name: label };
  }
}

function attr(value: string): string {
  return `"${esc(value)}"`;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
