import type { Reporter } from './Reporter';

const BAR_WIDTH  = 24;
const PASS_COLOR = '\x1b[32m'; // green
const FAIL_COLOR = '\x1b[31m'; // red
const DIM_COLOR  = '\x1b[2m';
const RESET      = '\x1b[0m';
/** Carriage-return + erase to end of line: overwrites the current line in-place. */
const ERASE      = '\r\x1b[K';

interface AdapterState {
  total:    number;
  done:     number;
  failures: number;
  finished: boolean;
  /** Last bar-fill level drawn (-1 = never). Used to skip redraws when nothing visual changed. */
  lastFill: number;
}

/**
 * Wraps any existing reporter and renders a live per-adapter progress bar to
 * stderr while the test run is in progress.  Falls back silently when stderr
 * is not a TTY (e.g. CI pipe capture) so it never corrupts machine-readable
 * output.
 *
 * Uses `\r\x1b[K` to overwrite the current line in-place.  No cursor-up
 * sequences are needed (and avoided since they are unreliable on Windows).
 * Each adapter's final state is committed with a newline so it remains
 * visible once the next adapter starts.
 *
 * Output format (one line per adapter, redrawn in-place, committed on finish):
 *   ✔ nodejs-v6.x   [████████████████████████]  107 / 107
 *   ✖ rust-2.x      [████████████████████████]  107 / 107  3 failed
 */
export class ProgressReporter implements Reporter {
  private readonly states   = new Map<string, AdapterState>();
  private activeAdapter: string | null = null;
  private readonly isTTY: boolean;

  constructor(private readonly inner: Reporter) {
    this.isTTY = Boolean((process.stderr as NodeJS.WriteStream).isTTY);
    if (this.isTTY) {
      process.stderr.write('\x1b[?25l'); // hide cursor
      const restore = () => process.stderr.write('\x1b[?25h');
      process.once('exit', restore);
      process.once('SIGINT', () => { restore(); process.exit(130); });
    }
  }

  // ── Reporter interface ────────────────────────────────────────────────────

  pass(label: string): void  { this.inner.pass(label); }
  fail(label: string, err: Error): void { this.inner.fail(label, err); }
  skip(label: string, reason: string): void { this.inner.skip(label, reason); }

  summary(): void {
    if (this.isTTY) {
      // Commit any active adapter line then restore cursor.
      if (this.activeAdapter) {
        const state = this.states.get(this.activeAdapter);
        if (state && !state.finished) {
          state.finished = true;
          this.draw(this.activeAdapter, true);
        }
      }
      process.stderr.write('\x1b[?25h'); // restore cursor
    }
    this.inner.summary();
  }

  beginAdapter(name: string, total: number): void {
    if (!this.states.has(name)) {
      this.states.set(name, { total, done: 0, failures: 0, finished: false, lastFill: -1 });
    }
    this.activeAdapter = name;
    if (this.isTTY) this.draw(name, false);
  }

  testDone(adapterName: string, done: number, total: number): void {
    const state = this.states.get(adapterName);
    if (!state) return;
    state.done  = done;
    state.total = total;
    const finished = done >= total;
    if (finished) state.finished = true;
    if (!this.isTTY) return;

    const fill = total > 0 ? Math.round((done / total) * BAR_WIDTH) : 0;
    // Only redraw when the visual bar fill changes (or on completion).
    if (fill !== state.lastFill || finished) {
      this.draw(adapterName, finished);
      if (finished) {
        // Commit this line — subsequent writes start on the next line.
        process.stderr.write('\n');
        this.activeAdapter = null;
      }
    }
  }

  /**
   * Print a stderr line captured from the subprocess above the active progress
   * bar, preserving the bar on the current line.
   */
  pushStderr(adapterName: string, line: string): void {
    if (!this.isTTY) {
      process.stderr.write(line + '\n');
      return;
    }
    // Erase current progress line, print the stderr line, then redraw progress.
    process.stderr.write(ERASE + line + '\n');
    if (this.activeAdapter) this.draw(this.activeAdapter, false);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private draw(name: string, finished: boolean): void {
    const state = this.states.get(name);
    if (!state) return;

    const { done, total, failures } = state;
    const fill     = total > 0 ? Math.round((done / total) * BAR_WIDTH) : 0;
    const bar      = '█'.repeat(fill) + '░'.repeat(BAR_WIDTH - fill);
    const countStr = total > 0 ? `${done} / ${total}` : '…';
    const failStr  = failures > 0 ? `  ${FAIL_COLOR}${failures} failed${RESET}` : '';
    const barColor = failures > 0 ? FAIL_COLOR : finished ? PASS_COLOR : DIM_COLOR;
    const tick     = finished
      ? (failures > 0 ? `${FAIL_COLOR}✖${RESET}` : `${PASS_COLOR}✔${RESET}`)
      : ' ';

    process.stderr.write(
      `${ERASE}${tick} ${name}  ${barColor}[${bar}]${RESET}  ${countStr}${failStr}`
    );
    state.lastFill = fill;
  }

  trackFailure(adapterName: string): void {
    const state = this.states.get(adapterName);
    if (state) state.failures++;
  }
}

export interface WithProgressResult {
  reporter: Reporter;
  /**
   * Attach a stderr-line handler to a SubprocessAdapter options object so that
   * subprocess output is routed through `pushStderr` instead of directly to
   * the terminal (which would corrupt the progress bar).
   */
  attachStderr: (adapterName: string, opts: { onStderrLine?: (line: string) => void }) => void;
}

/**
 * Wrap a reporter with progress display if stderr is a TTY, otherwise return
 * the reporter unchanged.
 */
export function withProgress(inner: Reporter): WithProgressResult {
  const progress = new ProgressReporter(inner);

  // Intercept fail to track failure counts per adapter.
  const innerFail = progress.fail.bind(progress);
  progress.fail = (label: string, err: Error) => {
    const m = /^\[([^\]]+)\]/.exec(label);
    if (m) progress.trackFailure(m[1]);
    innerFail(label, err);
  };

  function attachStderr(
    adapterName: string,
    opts: { onStderrLine?: (line: string) => void },
  ): void {
    opts.onStderrLine = (line) => progress.pushStderr(adapterName, line);
  }

  return { reporter: progress, attachStderr };
}
