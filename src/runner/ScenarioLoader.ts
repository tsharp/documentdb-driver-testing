import { readFile } from 'fs/promises';
import { parse } from 'yaml';
import type { Scenario } from '../protocol/types';

export async function loadScenario(filePath: string): Promise<Scenario> {
  const content = await readFile(filePath, 'utf-8');
  const parsed = parse(content) as Scenario;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid scenario file (expected a YAML object): ${filePath}`);
  }
  if (!Array.isArray(parsed.tests)) {
    throw new Error(`Scenario file is missing a "tests" array: ${filePath}`);
  }
  return parsed;
}

export async function loadScenarios(filePaths: string[]): Promise<Scenario[]> {
  return Promise.all(filePaths.map(loadScenario));
}
