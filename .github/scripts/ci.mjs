import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import process from 'node:process';
import projects from '../ci-projects.json' with { type: 'json' };

const [scope = 'full', project, ...extra] = process.argv.slice(2);
if (!['full', 'quality', 'browser', 'docker'].includes(scope) || extra.length || (project && (scope !== 'browser' || !projects.includes(project)))) {
  throw new Error('Usage: pnpm run ci | ci:quality | ci:browser [workspace-WIDTHxHEIGHT] | ci:docker. Full CI cannot filter tests.');
}
const root = resolve(import.meta.dirname, '../..');
process.chdir(root);
const output = resolve('ci-results', `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
await mkdir(output, { recursive: true });
const summary = { scope, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), node: process.version, started: new Date().toISOString(), status: 'running', stages: [] };
const sourceHash = createHash('sha256');
for (const file of execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean).sort()) {
  sourceHash.update(file);
  sourceHash.update(await readFile(file).catch(error => error.code === 'ENOENT' ? '<deleted>' : Promise.reject(error)));
}
summary.sourceSha256 = sourceHash.digest('hex');
summary.pnpm = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim();
const children = new Set();
let interrupted = false;
let saving = Promise.resolve();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  for (const child of children) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
});
async function run(stage, command, args, env = {}) {
  if (interrupted) throw new Error('CI interrupted.');
  const record = { stage, status: 'running', ...(env.IMAGINE_E2E_DATA_DIR ? { dataDirectory: env.IMAGINE_E2E_DATA_DIR, ...(env.E2E_PORT ? { port: Number(env.E2E_PORT) } : {}) } : {}) };
  let active;
  summary.stages.push(record);
  await save();
  process.stdout.write(`\n=== ${stage} ===\n`);
  try {
    await new Promise((yes, no) => {
      active = spawn(command, args, { cwd: root, stdio: 'inherit', detached: true, env: { ...process.env, CI: 'true', ...env } });
      children.add(active);
      active.once('error', no);
      active.once('exit', (code, signal) => code === 0 ? yes() : no(new Error(`${stage} failed (${signal ?? code}).`)));
    });
    record.status = 'passed';
  } catch (error) { record.status = 'failed'; throw error; }
  finally { children.delete(active); await save(); }
}
async function save() {
  const content = JSON.stringify(summary, null, 2) + '\n';
  saving = saving.then(() => writeFile(join(output, 'summary.json'), content));
  await saving;
}
async function port() {
  const server = createServer();
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const value = server.address().port;
  await new Promise((yes, no) => server.close(error => error ? no(error) : yes()));
  return value;
}
try {
  if (['full', 'quality'].includes(scope)) {
    for (const stage of ['lint', 'typecheck', 'test', 'build']) {
      // Unit tests import browser runtime helpers too; own that temporary root.
      if (stage === 'test') {
        const data = await mkdtemp(join(tmpdir(), 'imagine-media-studio-e2e-'));
        try { await run(stage, 'pnpm', [stage], { IMAGINE_E2E_DATA_DIR: data }); }
        finally { await rm(data, { recursive: true, force: true }); }
      } else await run(stage, 'pnpm', [stage]);
    }
  }
  if (['full', 'browser'].includes(scope)) {
    if (scope === 'browser') await run('build', 'pnpm', ['build']);
    // Each viewport gets a fresh server/database, matching the GitHub job matrix.
    const queue = [...(project ? [project] : projects)];
    const results = await Promise.allSettled(Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (queue.length) {
        const name = queue.shift();
        const data = await mkdtemp(join(tmpdir(), 'imagine-media-studio-e2e-'));
        try {
          await run(name, 'pnpm', ['test:e2e', `--project=${name}`, '--update-snapshots=none', `--output=${join(output, name, 'test-results')}`], {
          E2E_PORT: String(await port()), IMAGINE_E2E_DATA_DIR: data,
          PLAYWRIGHT_HTML_OUTPUT_DIR: join(output, name, 'report'),
        });
        } finally { await rm(data, { recursive: true, force: true }); }
      }
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  if (['full', 'docker'].includes(scope)) await run('docker', 'bash', ['.github/scripts/ci-docker.sh']);
  if (interrupted) throw new Error('CI interrupted.');
  summary.status = 'passed';
} catch (error) {
  summary.status = 'failed';
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  summary.finished = new Date().toISOString();
  await save();
  process.stdout.write(`CI scope=${scope}, result=${summary.status}; report: ${output}/summary.json\n`);
}
