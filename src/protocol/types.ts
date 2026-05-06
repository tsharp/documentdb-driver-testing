/**
 * Shared types used by both the harness runner and all driver adapters.
 * Adapters that live out-of-process communicate using JSON-serialised versions
 * of these same types over stdin/stdout.
 */

export interface ConnectOptions {
  serverSelectionTimeoutMS?: number;
  directConnection?: boolean;
  [key: string]: unknown;
}

/**
 * A single driver operation to execute.
 *
 * `object` controls what entity the operation targets:
 *   - "client"     → the MongoClient
 *   - "database"   → the database named by `database`
 *   - "collection" → the collection named by `collection` on `database`
 *   - "session0" / "session1" / … → a session stored by `saveResultAs` from a
 *                                    prior startSession operation
 *
 * Argument values starting with `$$` (e.g. `$$session0`) are resolved from the
 * test run context before the operation is dispatched to the adapter.
 */
export interface Operation {
  name: string;
  object: string;
  database?: string;
  collection?: string;
  arguments?: Record<string, unknown>;
  /** Store the result under this key; accessible as `$$<saveResultAs>` in later operations. */
  saveResultAs?: string;
  /** Assert the operation result matches this value or matcher. */
  expectResult?: unknown;
  /** Assert the operation produces an error matching this descriptor. */
  expectError?: ExpectedError;
}

export interface ExpectedError {
  isError: true;
  errorContains?: string;
  errorCode?: number;
  errorLabelsContain?: string[];
  errorLabelsOmit?: string[];
}

export interface OperationResult {
  result?: unknown;
  error?: DriverError;
}

export interface DriverError {
  message: string;
  code?: number;
  labels?: string[];
}

/** Controls which adapters and server versions a scenario or test case applies to. */
export interface RunOn {
  /** Adapter language filter. `"*"` (default) matches all languages. */
  language?: string;
  minServerVersion?: string;
  maxServerVersion?: string;
}

export interface TestCase {
  description: string;
  skipReason?: string;
  operations: Operation[];
}

export interface Scenario {
  description: string;
  minServerVersion?: string;
  maxServerVersion?: string;
  runOn?: RunOn[];
  /** Operations run before each test case. A failure here aborts the test case. */
  setup?: Operation[];
  /** Operations run after each test case regardless of outcome (errors are swallowed). */
  teardown?: Operation[];
  tests: TestCase[];
}
