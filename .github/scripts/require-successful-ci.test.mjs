import assert from 'node:assert/strict';
import { URL } from 'node:url';
import { latestMainCi, REQUIRED_CI_JOBS, requireSuccessfulCi } from './require-successful-ci.mjs';

export async function testCiReuseGuard() {
  const sha = 'a'.repeat(40);
  const run = { id: 10, head_sha: sha, event: 'push', head_branch: 'main', path: '.github/workflows/ci.yml', run_attempt: 1, status: 'completed', conclusion: 'success', html_url: 'https://github.com/owner/repo/actions/runs/10' };
  const jobs = REQUIRED_CI_JOBS.map(name => ({ name, status: 'completed', conclusion: 'success' }));
  const otherRuns = [
    { ...run, id: 20, head_sha: 'b'.repeat(40) },
    { ...run, id: 21, event: 'pull_request' },
    { ...run, id: 22, head_branch: 'topic' },
    { ...run, id: 23, path: '.github/workflows/release.yml' },
  ];
  assert.equal(latestMainCi(otherRuns, sha), undefined);
  assert.equal(latestMainCi([run, ...otherRuns], sha), run);

  function harness({ runs = [run], results = jobs, detail = run, pages } = {}) {
    let clock = 0, polls = 0;
    const requests = [], messages = [];
    return {
      requests, messages,
      options: {
        repository: 'owner/repo', sha, now: () => clock, timeoutMs: 30, intervalMs: 10,
        sleep: async ms => { clock += ms; }, log: message => messages.push(message),
        getJson: async path => {
          requests.push(path);
          if (path.includes('/workflows/ci.yml/runs?')) return { workflow_runs: typeof runs === 'function' ? runs(polls++) : runs };
          if (path.includes('/jobs?')) {
            const page = Number(new URL('https://api.github.com/' + path).searchParams.get('page'));
            return { jobs: pages ? pages[page - 1] ?? [] : results, total_count: pages ? pages.flat().length : results.length };
          }
          if (path.endsWith('/runs/10')) return typeof detail === 'function' ? detail() : detail;
          throw new Error('Unexpected API call: ' + path);
        },
      },
    };
  }

  const immediate = harness();
  assert.equal((await requireSuccessfulCi(immediate.options)).id, 10);
  assert.ok(immediate.messages[0].includes('Reusing successful main CI'));
  assert.ok(immediate.requests.some(path => path.includes('/attempts/1/jobs?')));
  assert.ok(immediate.requests[0].includes(`head_sha=${sha}&event=push&branch=main`));

  const waiting = harness({ runs: index => index === 0 ? [] : index === 1 ? [{ ...run, status: 'in_progress', conclusion: null }] : [run] });
  assert.equal((await requireSuccessfulCi(waiting.options)).id, 10);
  assert.equal(waiting.messages.filter(message => message.startsWith('Waiting')).length, 2);

  const replaced = harness({ runs: index => index === 0 ? [run] : [run, { ...run, id: 11, conclusion: 'failure' }] });
  await assert.rejects(requireSuccessfulCi(replaced.options), /concluded failure/);

  for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out', 'neutral']) {
    const failed = harness({ runs: [run, { ...run, id: 11, conclusion }] });
    await assert.rejects(requireSuccessfulCi(failed.options), new RegExp(`concluded ${conclusion}`));
  }
  for (const conclusion of ['failure', 'cancelled', 'skipped']) {
    const incomplete = harness({ results: jobs.map((job, index) => index === 1 ? { ...job, conclusion } : job) });
    await assert.rejects(requireSuccessfulCi(incomplete.options), /Required CI job/);
  }
  await assert.rejects(requireSuccessfulCi(harness({ results: jobs.slice(1) }).options), /Required CI job/);
  await assert.rejects(requireSuccessfulCi(harness({ results: [...jobs, jobs[0]] }).options), /Required CI job/);
  await assert.rejects(requireSuccessfulCi(harness({ runs: otherRuns }).options), /wait limit/);
  await assert.rejects(requireSuccessfulCi(harness({ runs: [{ ...run, status: 'queued' }] }).options), /wait limit/);
  await assert.rejects(requireSuccessfulCi(harness({ detail: { ...run, run_attempt: 2, status: 'in_progress' } }).options), /wait limit/);
  await assert.rejects(requireSuccessfulCi(harness({ detail: { ...run, conclusion: 'failure' } }).options), /no longer successful/);
  assert.equal((await requireSuccessfulCi(harness({ pages: [jobs.slice(0, 4), jobs.slice(4)] }).options)).id, 10);
  await assert.rejects(requireSuccessfulCi({ ...harness().options, sha: 'main' }), /full source commit/);
  await assert.rejects(requireSuccessfulCi({ ...harness().options, repository: 'owner/repo/../../other' }), /repository/);
  await assert.rejects(requireSuccessfulCi({ ...harness().options, getJson: async () => { throw new Error('API unavailable'); } }), /API unavailable/);
}
