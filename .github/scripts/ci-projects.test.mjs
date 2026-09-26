import { browserSummary } from './browser-results.mjs';
import assert from 'node:assert/strict';
import projects from '../ci-projects.json' with { type: 'json' };
import { selectProjects, projectsForEvent, representativeProjects } from './ci-projects.mjs';

export function testProjectSelection() {
  assert.deepEqual(browserSummary({ stats: { expected: 3, unexpected: 0, flaky: 1, skipped: 2 }, suites: [{ suites: [{ specs: [{ title: 'retry example', tests: [{ status: 'flaky' }] }] }] }] }), { passed: 3, failed: 0, flaky: 1, skipped: 2, flakyTests: ['retry example'] });
  assert.deepEqual(selectProjects('push', ['README.md']), projects);
  assert.deepEqual(selectProjects('workflow_dispatch', ['README.md']), projects);
  assert.deepEqual(selectProjects('pull_request', []), projects);
  assert.deepEqual(selectProjects('pull_request', ['apps/server/src/jobs/runner.ts', 'README.md']), representativeProjects);
  for (const path of ['apps/web/src/features/workspace/workspace.css', 'packages/shared/src/index.ts', 'e2e/fixtures.ts', '.github/scripts/ci.mjs', 'pnpm-lock.yaml', 'package.json', 'playwright.config.ts', 'Dockerfile']) {
    assert.deepEqual(selectProjects('pull_request', ['README.md', path]), projects, path);
  }
  assert.deepEqual(projectsForEvent({ eventName: 'pull_request', base: 'invalid', head: 'invalid' }), projects);
  const event = { eventName: 'pull_request', base: 'a'.repeat(40), head: 'b'.repeat(40) };
  assert.deepEqual(projectsForEvent(event, () => { throw new Error('missing history'); }), projects);
  assert.deepEqual(projectsForEvent(event, (base, head) => {
    assert.equal(base, event.base); assert.equal(head, event.head); return ['docs/README.md'];
  }), representativeProjects);
}
