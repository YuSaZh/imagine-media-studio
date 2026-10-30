import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import projects from '../ci-projects.json' with { type: 'json' };
import coverage from '../browser-coverage.json' with { type: 'json' };

export async function testCiEntry() {
  const temporary = await mkdtemp(join(tmpdir(), 'imagine-ci-entry-test-'));
  const reports = [];
  try {
    const fake = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('11.23.0'); process.exit(0); }
fs.appendFileSync(process.env.CI_ENTRY_LOG, JSON.stringify({ args, ci: process.env.CI, port: process.env.E2E_PORT, data: process.env.IMAGINE_E2E_DATA_DIR }) + '\\n');
if (args[0] === 'test:e2e' && process.env.CI_ENTRY_FAIL === 'test:e2e') {
  fs.mkdirSync(require('node:path').dirname(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({ stats: { expected: 2, unexpected: 1, flaky: 1, skipped: 3 }, suites: [{ specs: [{ title: 'retry fixture', tests: [{ status: 'flaky' }] }] }] }));
}
if (args[0] === process.env.CI_ENTRY_FAIL) process.exit(17);
`;
    for (const command of ['pnpm', 'bash']) await writeFile(join(temporary, command), fake, { mode: 0o700 });
    const log = join(temporary, 'commands.jsonl');
    const invoke = (args, failure = '') => {
      const result = spawnSync(process.execPath, ['.github/scripts/ci.mjs', ...args], {
        encoding: 'utf8', timeout: 30000,
        env: { ...process.env, PATH: `${temporary}:${process.env.PATH}`, CI_ENTRY_LOG: log, CI_ENTRY_FAIL: failure },
      });
      const path = result.stdout.match(/report: (.+)\/summary.json/u)?.[1];
      if (path) reports.push(path);
      return { ...result, path };
    };
    for (const args of [['full', projects[0]], ['browser', '--grep=x'], ['quality', 'skip']]) {
      const result = invoke(args);
      assert.notEqual(result.status, 0, 'Filtering a full gate or unknown options must fail.');
      assert.match(result.stderr, /Usage/u);
    }
    const complete = invoke(['full']);
    assert.equal(complete.status, 0, complete.stderr);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.slice(0, 4).map(call => call.args), [['lint'], ['typecheck'], ['test'], ['build']]);
    const browser = calls.filter(call => call.args[0] === 'test:e2e');
    assert.deepEqual(browser.map(call => call.args[1].replace('--project=', '')).sort(), [...projects].sort());
    assert.equal(new Set(browser.map(call => call.data)).size, 8);
    assert.equal(new Set(browser.map(call => call.port)).size, 8);
    assert.ok(browser.every(call => call.ci === 'true' && Number(call.port) >= 1024 && call.args.includes('--update-snapshots=none')));
    assert.deepEqual(calls.at(-1).args, ['.github/scripts/ci-docker.sh']);
    const passed = JSON.parse(await readFile(join(complete.path, 'summary.json'), 'utf8'));
    assert.equal(passed.status, 'passed');
    assert.ok(passed.stages.every(stage => stage.started && stage.finished && stage.durationMs >= 0));
    assert.deepEqual(passed.browserCoverage, coverage);
    for (const stage of passed.stages.filter(stage => stage.browserCoverage)) {
      assert.equal(stage.browserCoverage, coverage.representativeProjects.includes(stage.stage) ? 'full' : 'responsive');
    }
    await writeFile(log, '');
    const failed = invoke(['full'], 'typecheck');
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /typecheck failed/u);
    const summary = JSON.parse(await readFile(join(failed.path, 'summary.json'), 'utf8'));
    assert.equal(summary.status, 'failed');
    assert.deepEqual(summary.stages.map(stage => stage.stage), ['lint', 'typecheck']);
    const browserFailure = invoke(['browser', projects[0]], 'test:e2e');
    assert.notEqual(browserFailure.status, 0);
    const browserReport = JSON.parse(await readFile(join(browserFailure.path, 'summary.json'), 'utf8'));
    assert.equal(browserReport.status, 'failed');
    assert.deepEqual(browserReport.stages.at(-1).browser, { passed: 2, failed: 1, flaky: 1, skipped: 3, flakyTests: ['retry fixture'] });
    assert.equal(browserReport.stages.at(-1).selectedTests, 7);
  } finally {
    for (const path of reports) {
      assert.ok(path.startsWith(resolve('ci-results') + '/'));
      await rm(path, { recursive: true, force: true });
    }
    await rm(temporary, { recursive: true, force: true });
  }
}
