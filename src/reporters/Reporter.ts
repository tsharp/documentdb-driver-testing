export interface Reporter {
  pass(label: string): void;
  fail(label: string, err: Error): void;
  skip(label: string, reason: string): void;
  /** Called once after all tests have run. Sets `process.exitCode` on failure. */
  summary(): void;
  /** Called before the first test for an adapter runs. */
  beginAdapter?(name: string, total: number): void;
  /** Called after each individual test (pass, fail, or skip) for an adapter. */
  testDone?(adapterName: string, done: number, total: number): void;
}
