import type { Reporter } from './Reporter';

/**
 * TAP (Test Anything Protocol) reporter.
 * Output is compatible with any TAP consumer (tap, tap-spec, tap-junit, etc.).
 */
export class TapReporter implements Reporter {
  private count = 0;
  private failCount = 0;

  pass(label: string): void {
    this.count++;
    console.log(`ok ${this.count} - ${label}`);
  }

  fail(label: string, err: Error): void {
    this.count++;
    this.failCount++;
    console.log(`not ok ${this.count} - ${label}`);
    console.log(`  ---`);
    // Indent subsequent lines so TAP parsers treat it as a YAML block
    const indented = err.message.split('\n').join('\n  ');
    console.log(`  message: "${indented}"`);
    if (err.stack) {
      const stackLines = err.stack.split('\n').slice(1).join('\n  ');
      console.log(`  stack: |\n    ${stackLines}`);
    }
    console.log(`  ...`);
  }

  skip(label: string, reason: string): void {
    this.count++;
    console.log(`ok ${this.count} - # SKIP ${label} (${reason})`);
  }

  summary(): void {
    console.log(`\n1..${this.count}`);
    if (this.failCount > 0) {
      console.error(`# ${this.failCount} failure(s) out of ${this.count} test(s)`);
      process.exitCode = 1;
    } else {
      console.log(`# all ${this.count} test(s) passed`);
    }
  }
}
