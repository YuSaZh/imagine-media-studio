import { availableParallelism, totalmem } from 'node:os';
import process from 'node:process';
import projects from '../ci-projects.json' with { type: 'json' };

export function ciOptions(args) {
  const [scope = 'full', project, ...extra] = args;
  if (!['full', 'quality', 'browser', 'docker'].includes(scope) || extra.length ||
      (project && (scope !== 'browser' || !projects.includes(project)))) {
    throw new Error('Usage: pnpm run ci | ci:quality | ci:browser [workspace-WIDTHxHEIGHT] | ci:docker. Full CI cannot filter tests.');
  }
  return { scope, project };
}

export function browserConcurrency(value = process.env.CI_BROWSER_CONCURRENCY, cpu = availableParallelism(), memory = totalmem()) {
  if (value !== undefined && !/^[1-8]$/.test(value)) throw new Error('CI_BROWSER_CONCURRENCY must be an integer from 1 to 8.');
  return value === undefined ? Math.max(1, Math.min(4, cpu, Math.floor(memory / (3 * 1024 ** 3)))) : Number(value);
}
