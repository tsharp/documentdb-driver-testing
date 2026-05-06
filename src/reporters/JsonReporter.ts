import type { Reporter } from './Reporter';

interface TestResult {
  label: string;
  status: 'pass' | 'fail' | 'skip';
  error?: string;
  skipReason?: string;
}

/** Emits a single JSON document to stdout after all tests have run. */
export class JsonReporter implements Reporter {
  private results: TestResult[] = [];

  pass(label: string): void {
    this.results.push({ label, status: 'pass' });
  }

  fail(label: string, err: Error): void {
    this.results.push({ label, status: 'fail', error: err.message });
  }

  skip(label: string, reason: string): void {
    this.results.push({ label, status: 'skip', skipReason: reason });
  }

  summary(): void {
    const total = this.results.length;
    const passed = this.results.filter((r) => r.status === 'pass').length;
    const failed = this.results.filter((r) => r.status === 'fail').length;
    const skipped = this.results.filter((r) => r.status === 'skip').length;

    console.log(
      JSON.stringify(
        { summary: { total, passed, failed, skipped }, results: this.results },
        null,
        2,
      ),
    );

    if (failed > 0) {
      process.exitCode = 1;
    }
  }
}
