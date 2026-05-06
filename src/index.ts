import minimist from 'minimist';
import fg from 'fast-glob';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { MongoClient } from 'mongodb';
import { loadScenarios } from './runner/ScenarioLoader';
import { Harness } from './runner/Harness';
import { TapReporter } from './reporters/TapReporter';
import { JsonReporter } from './reporters/JsonReporter';
import { JUnitReporter } from './reporters/JUnitReporter';
import { MatrixJsonReporter } from './reporters/MatrixJsonReporter';
import { withProgress } from './reporters/ProgressReporter';
import { SubprocessAdapter } from './protocol/SubprocessAdapter';
import type { DriverAdapter } from './protocol/DriverAdapter';

const argv = minimist(process.argv.slice(2), {
  string: ['adapters', 'tests', 'uri', 'reporter', 'report-file', 'target', 'server-version'],
  default: {
    adapters: 'nodejs-v6.x',
    tests: 'tests/**/*.yml',
    uri: process.env['MONGODB_URI'] ?? 'mongodb://localhost:27017',
    reporter: 'tap',
    'report-file': 'out/test-results.xml',
    target: 'unknown',
  },
});

/** Detect the server version by running buildInfo against the live server. */
async function detectServerVersion(uri: string): Promise<string> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const info = await client.db('admin').command({ buildInfo: 1 });
    return String(info['version'] ?? 'unknown');
  } catch {
    return 'unknown';
  } finally {
    await client.close().catch(() => {});
  }
}

/** Read the version field from a Cargo.toml file. */
function readCargoVersion(cargoTomlPath: string): string {
  try {
    const text = readFileSync(cargoTomlPath, 'utf-8');
    const m = /^version\s*=\s*"([^"]+)"/m.exec(text);
    return m ? m[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Read the version field from a package.json file. */
function readPackageVersion(pkgJsonPath: string): string {
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Resolve the version string for a given adapter name. */
function adapterVersion(adapterName: string): string {
  // Rust adapters: read version from Cargo.toml
  const cargoPath = `adapters/${adapterName}/Cargo.toml`;
  if (existsSync(cargoPath)) return readCargoVersion(cargoPath);
  // Node.js adapters: read the mongodb version from the adapter's own node_modules
  if (adapterName.startsWith('nodejs')) {
    const localPkg = `adapters/${adapterName}/node_modules/mongodb/package.json`;
    if (existsSync(localPkg)) return readPackageVersion(localPkg);
    // Fall back to root node_modules if adapter hasn't been npm-installed yet
    return readPackageVersion('node_modules/mongodb/package.json');
  }
  return 'unknown';
}

function buildAdapter(
  name: string,
  onStderrLine?: (line: string) => void,
): DriverAdapter {
  // Node.js subprocess adapters: run shim.ts via ts-node from the adapter's own dir
  // so that Node resolves `mongodb` from the adapter's local node_modules.
  if (name.startsWith('nodejs')) {
    const adapterDir = resolve(`adapters/${name}`);
    const shimPath = resolve(`adapters/${name}/shim.ts`);
    return new SubprocessAdapter({
      name,
      language: 'nodejs',
      bin: 'node',
      args: ['-r', 'ts-node/register', shimPath],
      cwd: adapterDir,
      onStderrLine,
    });
  }
  // Rust adapters: compiled binary
  if (name === 'rust' || name.startsWith('rust-')) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    return new SubprocessAdapter({
      name,
      language: 'rust',
      bin: `adapters/${name}/target/release/shim${ext}`,
      onStderrLine,
    });
  }
  // Generic versioned adapter fallback
  const versionedMatch = /^([a-z]+)-[\d]/.exec(name);
  const language = versionedMatch ? versionedMatch[1] : name;
  const ext = process.platform === 'win32' ? '.exe' : '';
  return new SubprocessAdapter({
    name,
    language,
    bin: `adapters/${name}/target/release/shim${ext}`,
    onStderrLine,
  });
}

async function main(): Promise<void> {
  const adapterNames = String(argv['adapters'])
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const testGlob = String(argv['tests']);
  const uri = String(argv['uri']);
  const reporterName = String(argv['reporter']);
  const reportFile = String(argv['report-file']);
  const target = String(argv['target']);
  const serverVersion =
    (argv['server-version'] as string | undefined) ??
    (reporterName === 'matrix' ? await detectServerVersion(uri) : undefined);

  const testFiles = await fg(testGlob, { absolute: true });
  if (testFiles.length === 0) {
    console.error(`No test files found matching: ${testGlob}`);
    process.exit(1);
  }

  const scenarios = await loadScenarios(testFiles);

  let baseReporter;
  if (reporterName === 'json') {
    baseReporter = new JsonReporter();
  } else if (reporterName === 'junit') {
    baseReporter = new JUnitReporter(reportFile);
  } else if (reporterName === 'matrix') {
    const adapterVersions = new Map(adapterNames.map((n) => [n, adapterVersion(n)]));
    baseReporter = new MatrixJsonReporter(
      reportFile,
      target,
      serverVersion ?? 'unknown',
      adapterVersions,
    );
  } else {
    baseReporter = new TapReporter();
  }

  const { reporter, attachStderr } = withProgress(baseReporter);
  const adapters = adapterNames.map((name) => {
    const stderrOpts: { onStderrLine?: (line: string) => void } = {};
    attachStderr(name, stderrOpts);
    return buildAdapter(name, stderrOpts.onStderrLine);
  });

  const harness = new Harness(adapters, scenarios, reporter, { uri, serverVersion, target });
  await harness.run();
}

main().catch((err: unknown) => {
  console.error('Fatal harness error:', err);
  process.exit(1);
});
