import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import projects from '../ci-projects.json' with { type: 'json' };
import coverage from '../browser-coverage.json' with { type: 'json' };

export async function testBrowserCoverage() {
  assert.deepEqual(coverage.representativeProjects, ['workspace-1440x900', 'workspace-390x844']);
  assert.match(coverage.workflowTag, /^@[a-z][a-z-]*$/u);
  const data = await mkdtemp(join(tmpdir(), 'imagine-media-studio-e2e-coverage-'));
  try {
    // Real collection exercises Playwright's tag filtering, without a server or browser.
    const listed = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--list', '--reporter=json'], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CI: 'true', IMAGINE_E2E_DATA_DIR: data },
    });
    assert.equal(listed.status, 0, listed.stderr);
    const report = JSON.parse(listed.stdout);
    assert.deepEqual(report.config.projects.map(project => project.name), projects);
    const inventory = new Map();
    const visit = (suites, parents = []) => {
      for (const suite of suites ?? []) {
        for (const spec of suite.specs ?? []) {
          const title = [...parents, spec.title].join(' > ');
          const key = `${spec.file}: ${title}`;
          const workflow = spec.tags.includes(coverage.workflowTag.slice(1));
          const item = inventory.get(key) ?? { file: spec.file, title, workflow, projects: [] };
          assert.equal(item.workflow, workflow, key);
          item.projects.push(...spec.tests.map(test => test.projectName));
          inventory.set(key, item);
        }
        visit(suite.suites, [...parents, suite.title]);
      }
    };
    visit(report.suites);
    const cases = [...inventory.values()];
    assert.ok(cases.some(test => test.workflow));
    assert.ok(cases.some(test => !test.workflow));
    for (const test of cases) assert.deepEqual([...test.projects].sort(),
      [...(test.workflow ? coverage.representativeProjects : projects)].sort(), test.title);
    const matrix = projects.map(name => ({
      project: name,
      coverage: coverage.representativeProjects.includes(name) ? 'full' : 'responsive',
      selected: cases.filter(test => test.projects.includes(name)).length,
      omittedByPolicy: cases.filter(test => !test.projects.includes(name)).length,
    }));
    const result = { policy: coverage, uniqueCases: cases.length, matrix,
      totalSelected: matrix.reduce((sum, project) => sum + project.selected, 0),
      omittedByPolicy: matrix.reduce((sum, project) => sum + project.omittedByPolicy, 0), cases };
    await mkdir('ci-results', { recursive: true });
    await writeFile('ci-results/browser-coverage.json', JSON.stringify(result, null, 2) + '\n');
    process.stdout.write(`Browser coverage: ${cases.length} unique cases, ${result.totalSelected} selected executions, ${result.omittedByPolicy} viewport duplicates omitted.\n`);
  } finally { await rm(data, { recursive: true, force: true }); }
}
