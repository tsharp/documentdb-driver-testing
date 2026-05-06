import { coerce, lt, gt } from 'semver';
import type { RunOn } from '../protocol/types';
import type { DriverAdapter } from '../protocol/DriverAdapter';

/**
 * Returns true if `serverVersion` satisfies the optional min/max bounds.
 * Missing bounds are treated as "no constraint".
 */
export function serverSatisfies(
  serverVersion: string,
  minVersion?: string,
  maxVersion?: string,
): boolean {
  const sv = coerce(serverVersion);
  if (!sv) return true; // unparseable version — skip gating

  if (minVersion) {
    const min = coerce(minVersion);
    if (min && lt(sv, min)) return false;
  }
  if (maxVersion) {
    const max = coerce(maxVersion);
    if (max && gt(sv, max)) return false;
  }
  return true;
}

/**
 * Returns true if the adapter matches at least one entry in the `runOn` list.
 * If `runOn` is empty or undefined, every adapter matches.
 */
export function adapterMatchesRunOn(
  adapter: DriverAdapter,
  runOn: RunOn[] | undefined,
  serverVersion: string,
): boolean {
  if (!runOn || runOn.length === 0) return true;
  return runOn.some((r) => {
    const langOk = !r.language || r.language === '*' || r.language === adapter.language;
    const versionOk = serverSatisfies(serverVersion, r.minServerVersion, r.maxServerVersion);
    return langOk && versionOk;
  });
}
