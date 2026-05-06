import type { ConnectOptions, Operation, OperationResult } from './types';

/**
 * The contract every driver adapter must satisfy.
 *
 * In-process adapters (e.g. the Node.js adapter) implement this directly.
 * Out-of-process adapters (Rust, Python, Java, …) are wrapped by
 * `SubprocessAdapter`, which speaks a line-delimited JSON protocol over
 * stdin/stdout with the language-specific shim.
 */
export interface DriverAdapter {
  /** Human-readable identifier, e.g. "nodejs-6.x" or "rust-2.x". */
  readonly name: string;
  /** Language/runtime tag used for `runOn` filtering, e.g. "typescript", "rust". */
  readonly language: string;

  /** Establish a connection to the MongoDB-compatible server. */
  connect(uri: string, options?: ConnectOptions): Promise<void>;

  /** Close all open sessions and the underlying connection. */
  disconnect(): Promise<void>;

  /**
   * Execute a single driver operation and return its result or a structured error.
   * Adapters must never throw — all errors are returned as `{ error: DriverError }`.
   */
  runOperation(op: Operation): Promise<OperationResult>;

  /**
   * Reset per-test state (e.g. end open sessions) without closing the connection.
   * Called by the harness between test cases within the same scenario.
   */
  cleanupTestState?(): Promise<void>;
}
