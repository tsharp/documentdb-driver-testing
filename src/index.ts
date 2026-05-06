import minimist from 'minimist';
import fg from 'fast-glob';
import { loadScenarios } from './runner/ScenarioLoader';
import { Harness } from './runner/Harness';
import { TapReporter } from './reporters/TapReporter';
import { JsonReporter } from './reporters/JsonReporter';
import { NodejsDriverAdapter } from '../adapters/nodejs';
import { SubprocessAdapter } from './protocol/SubprocessAdapter';
import type { DriverAdapter } from './protocol/DriverAdapter';

const argv = minimist(process.argv.slice(2), {
  string: ['adapters', 'tests', 'uri', 'reporter', 'server-version'],
  default: {
    adapters: 'nodejs',
    tests: 'tests/**/*.yml',
    uri: process.env['MONGODB_URI'] ?? 'mongodb://localhost:27017',
    reporter: 'tap',
  },
});

function buildAdapter(name: string): DriverAdapter {
  switch (name) {
    case 'nodejs':
      return new NodejsDriverAdapter();
    case 'rust': {
      const ext = process.platform === 'win32' ? '.exe' : '';
      const bin = `adapters/rust/target/release/shim${ext}`;
      return new SubprocessAdapter({ name: 'rust', language: 'rust', bin });
    }
    default: {
      // Support versioned adapter names like "rust-3.6" or "python-1.x".
      // The language is the portion before the first hyphen-digit sequence,
      // e.g. "rust-3.6" → language "rust", dir "adapters/rust-3.6".
      const versionedMatch = /^([a-z]+)-[\d]/.exec(name);
      const language = versionedMatch ? versionedMatch[1] : name;
      const ext = process.platform === 'win32' ? '.exe' : '';
      return new SubprocessAdapter({
        name,
        language,
        bin: `adapters/${name}/target/release/shim${ext}`,
      });
    }
  }
}

async function main(): Promise<void> {
  const adapterNames = String(argv['adapters'])
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const testGlob = String(argv['tests']);
  const uri = String(argv['uri']);
  const reporterName = String(argv['reporter']);
  const serverVersion = argv['server-version'] as string | undefined;

  const testFiles = await fg(testGlob, { absolute: true });
  if (testFiles.length === 0) {
    console.error(`No test files found matching: ${testGlob}`);
    process.exit(1);
  }

  const adapters = adapterNames.map(buildAdapter);
  const scenarios = await loadScenarios(testFiles);
  const reporter = reporterName === 'json' ? new JsonReporter() : new TapReporter();

  const harness = new Harness(adapters, scenarios, reporter, { uri, serverVersion });
  await harness.run();
}

main().catch((err: unknown) => {
  console.error('Fatal harness error:', err);
  process.exit(1);
});
