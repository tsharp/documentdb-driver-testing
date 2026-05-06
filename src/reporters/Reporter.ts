export interface Reporter {
  pass(label: string): void;
  fail(label: string, err: Error): void;
  skip(label: string, reason: string): void;
  /** Called once after all tests have run. Sets `process.exitCode` on failure. */
  summary(): void;
}
