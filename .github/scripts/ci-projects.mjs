import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import projects from '../ci-projects.json' with { type: 'json' };

export const representativeProjects = ['workspace-1440x900', 'workspace-390x844'];
export function selectProjects(event, files = []) {
  // Unknown scope fails open to more coverage, never to fewer release gates.
  if (event !== 'pull_request' || files.length === 0) return projects;
  const browserInputs = /^(apps\/web\/|packages\/|e2e\/|fixtures\/|\.github\/|playwright\.config\.|package\.json$|pnpm-|tsconfig|eslint|Dockerfile$|docker-compose)/u;
  return files.some(file => browserInputs.test(file)) ? projects : representativeProjects;
}
export function projectsForEvent(event, diff = (base, head) => execFileSync('git', ['diff', '--name-only', '-z', `${base}...${head}`], { encoding: 'utf8' }).split('\0').filter(Boolean)) {
  if (event?.eventName !== 'pull_request') return projects;
  if (![event.base, event.head].every(sha => /^[a-f0-9]{40}$/u.test(sha ?? ''))) return projects;
  try { return selectProjects('pull_request', diff(event.base, event.head)); }
  catch { return projects; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const selected = projectsForEvent({ eventName: process.env.GITHUB_EVENT_NAME, base: process.env.CI_BASE_SHA, head: process.env.CI_HEAD_SHA });
  const output = `projects=${JSON.stringify(selected)}\n`;
  process.stdout.write(output);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, output);
}
