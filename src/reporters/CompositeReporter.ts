import type { Reporter } from './Reporter';

export class CompositeReporter implements Reporter {
    constructor(private readonly reporters: Reporter[]) { }

    pass(label: string): void {
        for (const reporter of this.reporters) reporter.pass(label);
    }

    fail(label: string, err: Error): void {
        for (const reporter of this.reporters) reporter.fail(label, err);
    }

    skip(label: string, reason: string): void {
        for (const reporter of this.reporters) reporter.skip(label, reason);
    }

    summary(): void {
        for (const reporter of this.reporters) reporter.summary();
    }

    beginAdapter(name: string, total: number): void {
        for (const reporter of this.reporters) reporter.beginAdapter?.(name, total);
    }

    testDone(adapterName: string, done: number, total: number): void {
        for (const reporter of this.reporters) reporter.testDone?.(adapterName, done, total);
    }
}