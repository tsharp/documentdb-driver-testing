import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface } from 'readline';
import type { DriverAdapter } from './DriverAdapter';
import type { ConnectOptions, Operation, OperationResult } from './types';

export interface SubprocessAdapterOptions {
  /** Name shown in test output, e.g. "rust-3.6" or "python-1.x". */
  name: string;
  /**
   * Language tag used for `runOn` filtering, e.g. "rust", "python".
   * Defaults to `name` when not provided.
   */
  language?: string;
  /** Path to the shim binary (or JAR file when `runtime` is set). */
  bin: string;
  /** Extra arguments passed to the binary. */
  args?: string[];
  /**
   * When set, the shim is launched as `<runtime> <bin> [...args]`.
   * Use "java" for JAR-based shims.
   */
  runtime?: string;
  /** Working directory for the spawned process. */
  cwd?: string;
}

/** Wire protocol message sent from harness → shim over stdin. */
interface OutboundMessage {
  id: number;
  type: 'connect' | 'disconnect' | 'operation';
  payload: unknown;
}

/** Wire protocol message received from shim → harness over stdout. */
interface InboundMessage {
  id: number;
  result?: unknown;
  error?: { message: string; code?: number; labels?: string[] };
}

interface PendingRequest {
  resolve: (value: OperationResult) => void;
  reject: (reason: Error) => void;
}

/**
 * Generic adapter for out-of-process drivers.
 *
 * The shim (written in the target language) must implement a simple
 * request/response protocol over stdin/stdout:
 *   - Reads one JSON line per request from stdin (`OutboundMessage`)
 *   - Writes one JSON line per response to stdout (`InboundMessage`)
 *   - Writes diagnostic/debug output to stderr (passed through unchanged)
 *
 * Responses may arrive out of order; the `id` field correlates them.
 */
export class SubprocessAdapter implements DriverAdapter {
  readonly name: string;
  readonly language: string;

  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;

  constructor(private readonly opts: SubprocessAdapterOptions) {
    this.name = opts.name;
    this.language = opts.language ?? opts.name;
  }

  private ensureStarted(): void {
    if (this.proc !== null) return;

    const [cmd, ...baseArgs] = this.opts.runtime
      ? [this.opts.runtime, this.opts.bin, ...(this.opts.args ?? [])]
      : [this.opts.bin, ...(this.opts.args ?? [])];

    this.proc = spawn(cmd, baseArgs, {
      stdio: ['pipe', 'pipe', 'inherit'],
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
    });

    // Capture the pending map for THIS spawn so the exit listener only
    // rejects requests that belong to this process, not a future reconnect.
    const spawnPending = this.pending;

    this.rl = createInterface({ input: this.proc.stdout! });
    this.rl.on('line', (line) => {
      let msg: InboundMessage;
      try {
        msg = JSON.parse(line) as InboundMessage;
      } catch {
        return; // malformed line — ignore
      }
      const pending = spawnPending.get(msg.id);
      if (!pending) return;
      spawnPending.delete(msg.id);
      pending.resolve(msg.error ? { error: msg.error } : { result: msg.result });
    });

    this.proc.on('exit', (code) => {
      const err = new Error(`Subprocess "${this.name}" exited with code ${code}`);
      for (const { reject } of spawnPending.values()) reject(err);
      spawnPending.clear();
    });
  }

  private send(type: OutboundMessage['type'], payload: unknown): Promise<OperationResult> {
    this.ensureStarted();
    const id = this.nextId++;
    const msg: OutboundMessage = { id, type, payload };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin!.write(JSON.stringify(msg) + '\n', (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async connect(uri: string, options?: ConnectOptions): Promise<void> {
    await this.send('connect', { uri, options });
  }

  async disconnect(): Promise<void> {
    await this.send('disconnect', {});
    this.proc?.stdin?.end();
    this.rl?.close();
    this.proc = null;
    this.rl = null;
    this.nextId = 1;
    // Fresh map so the next spawn's exit listener doesn't touch stale entries.
    this.pending = new Map();
  }

  async runOperation(op: Operation): Promise<OperationResult> {
    return this.send('operation', op);
  }
}
