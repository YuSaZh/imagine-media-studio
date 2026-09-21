import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const execFile = promisify(execFileCallback);
export const REQUIRED_CI_JOBS = [
  'Lint, typecheck, unit, build',
  ...['1920x1080', '1440x900', '1280x800', '1024x1366', '834x1194', '430x932', '390x844', '360x800']
    .map(viewport => `Workspace browser gates: workspace-${viewport}`),
  'Single-container PR 3, PR 5, PR 6 and PR 8 API, video, adapter, archive and persistence smoke',
];

export function latestMainCi(runs, sha) {
  return runs.filter(run => run.head_sha === sha && run.event === 'push' && run.head_branch === 'main' && run.path === '.github/workflows/ci.yml')
    .sort((a, b) => b.id - a.id)[0];
}

export function assertSuccessfulJobs(jobs) {
  for (const name of REQUIRED_CI_JOBS) {
    const matches = jobs.filter(job => job.name === name);
    if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') {
      throw new Error(`Required CI job did not succeed: ${name}`);
    }
  }
}

const githubJson = async path => {
  const { stdout } = await execFile('gh', ['api', '--method', 'GET', path], { maxBuffer: 8 * 1024 * 1024, timeout: 60000 });
  return JSON.parse(stdout);
};

/** Reuse existing trusted CI only. Never dispatch CI or accept local reports. */
export async function requireSuccessfulCi({
  repository, sha, getJson = githubJson, now = Date.now,
  sleep = delay,
  timeoutMs = 45 * 60 * 1000, intervalMs = 15000, log = message => process.stdout.write(`${message}\n`),
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !/^[a-f0-9]{40}$/.test(sha ?? '')) {
    throw new Error('A repository and full source commit SHA are required.');
  }
  const base = `repos/${repository}/actions`;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const data = await getJson(`${base}/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=100`);
    const run = latestMainCi(data.workflow_runs, sha);
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error(`CI run ${run.id} concluded ${run.conclusion}; fix or rerun CI before releasing.`);
      const jobs = [];
      for (let page = 1; ; page++) {
        if (page > 20) throw new Error('CI job pagination exceeded its safety bound.');
        const result = await getJson(`${base}/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`);
        jobs.push(...result.jobs);
        if (jobs.length >= result.total_count || result.jobs.length === 0) break;
      }
      assertSuccessfulJobs(jobs);
      // A rerun started during the job lookup must not reuse the prior attempt.
      const current = await getJson(`${base}/runs/${run.id}`);
      if (current.run_attempt === run.run_attempt && current.status === 'completed') {
        if (current.conclusion !== 'success') throw new Error(`CI run ${run.id} is no longer successful.`);
        const latest = latestMainCi((await getJson(`${base}/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=100`)).workflow_runs, sha);
        if (latest?.id !== run.id || latest.run_attempt !== run.run_attempt || latest.status !== 'completed' || latest.conclusion !== 'success') {
          await sleep(intervalMs);
          continue;
        }
        log(`Reusing successful main CI: ${run.html_url} (commit ${sha}, attempt ${run.run_attempt})`);
        return run;
      }
    }
    log(run ? `Waiting for main CI run ${run.id} for ${sha}.` : `Waiting for main CI to appear for ${sha}.`);
    await sleep(intervalMs);
  }
  throw new Error(`No successful main CI for ${sha} within the wait limit; publication remains blocked.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await requireSuccessfulCi({ repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA });
}
