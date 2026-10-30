import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { ciOptions } from './ci-options.mjs';

const root = resolve(import.meta.dirname, '../..');
export const cacheDirectory = join(root, '.ci-cache');

export async function toolchainIdentity(architecture = process.arch) {
  const arch = { x64: 'amd64', arm64: 'arm64' }[architecture];
  if (!arch) throw new Error('CI toolchain supports x64 and arm64 Linux containers.');
  const configSource = await readFile(join(root, '.github/ci/toolchain.json'));
  const config = JSON.parse(configSource);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.packageManager !== `pnpm@${config.pnpmVersion}` || pkg.devDependencies['@playwright/test'] !== config.playwrightVersion) {
    throw new Error('Update the pinned CI toolchain when pnpm or Playwright changes.');
  }
  const digest = createHash('sha256').update(configSource)
    .update(await readFile(join(root, '.github/ci/Dockerfile'))).update(arch).digest('hex');
  const key = `linux-${arch}-${digest}`;
  return { config, key, image: `imagine-ci-toolchain:${key}`, platform: `linux/${arch}`, archive: join(cacheDirectory, `toolchain-${key}.tar.gz`) };
}

function docker(args, options = {}) {
  return execFileSync('docker', args, { cwd: root, encoding: 'utf8', ...options });
}

function imageFingerprint(image) {
  try { return docker(['image', 'inspect', image, '--format', '{{ index .Config.Labels "org.imagine.ci.fingerprint" }}'], { stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

async function ensureImage(identity) {
  const { archive } = identity;
  let fingerprint = imageFingerprint(identity.image);
  if (fingerprint !== null && fingerprint !== identity.key) throw new Error('Existing CI image does not match its content fingerprint.');
  if (fingerprint === null) {
    try {
      await stat(archive);
      docker(['load', '--input', archive], { stdio: 'inherit' });
      fingerprint = imageFingerprint(identity.image);
      if (fingerprint !== identity.key) throw new Error('Cached CI archive does not match this source toolchain.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const { config } = identity;
      docker(['build', '--platform', identity.platform, '--file', join(root, '.github/ci/Dockerfile'), '--tag', identity.image,
        '--build-arg', `NODE_IMAGE=${config.nodeImage}`, '--build-arg', `BROWSER_IMAGE=${config.browserImage}`,
        '--build-arg', `DOCKER_IMAGE=${config.dockerImage}`, '--build-arg', `PNPM_VERSION=${config.pnpmVersion}`,
        '--build-arg', `NOTO_CORE_VERSION=${config.fontsNotoCoreVersion}`, '--build-arg', `NOTO_CJK_VERSION=${config.fontsNotoCjkVersion}`,
        '--build-arg', `CI_FINGERPRINT=${identity.key}`, join(root, '.github/ci')], { stdio: 'inherit' });
    }
  }
  if (imageFingerprint(identity.image) !== identity.key) throw new Error('CI toolchain image verification failed.');
}

async function workspaceModulePaths() {
  const paths = [join(root, 'node_modules')];
  for (const area of ['apps', 'packages']) for (const entry of await readdir(join(root, area), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, area, entry.name);
    try { await stat(join(directory, 'package.json')); paths.push(join(directory, 'node_modules')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return paths;
}

async function cleanupRuntime(name, volumes, runtime) {
  const errors = [];
  try { docker(['rm', '--force', name], { stdio: 'ignore' }); } catch { /* --rm may already have removed this task's container. */ }
  for (const volume of volumes) {
    try { docker(['volume', 'rm', volume], { stdio: 'ignore' }); } catch (error) { errors.push(error); }
  }
  await rm(runtime, { recursive: true, force: true });
  if (errors.length) throw new AggregateError(errors, 'Could not remove task CI dependency volumes.');
}

async function publishSummaries(beforeReports) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  for (const entry of await readdir(join(root, 'ci-results'))) {
    if (beforeReports.has(entry)) continue;
    const path = join(root, 'ci-results', entry, 'summary.json');
    try {
      const report = JSON.parse(await readFile(path, 'utf8'));
      for (const stage of report.stages ?? []) if (stage.browser) await appendFile(process.env.GITHUB_STEP_SUMMARY,
        `${stage.stage} (${stage.browserCoverage ?? 'full'}, ${stage.selectedTests ?? stage.browser.passed + stage.browser.failed + stage.browser.flaky + stage.browser.skipped} selected): ${stage.browser.passed} passed, ${stage.browser.failed} failed, ${stage.browser.flaky} flaky, ${stage.browser.skipped} conditional skips\n${stage.browser.flakyTests.map(test => `- Retry passed: ${test}`).join('\n')}\n`);
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
}

async function execute(identity, options) {
  const uid = process.getuid();
  const gid = process.getgid();
  const endpoint = process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock';
  if (!endpoint.startsWith('unix://')) throw new Error('CI toolchain requires a local Unix Docker socket.');
  const socket = endpoint.slice('unix://'.length);
  const socketGroup = (await stat(socket)).gid;
  const runtime = await mkdtemp(join(tmpdir(), 'imagine-ci-runtime-'));
  const id = randomUUID();
  const name = `imagine-ci-toolchain-${id}`;
  const volumes = [];
  const mounts = [];
  const beforeReports = new Set(await readdir(join(root, 'ci-results')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)));
  const store = join(cacheDirectory, 'pnpm-store');
  let child;
  let signal;
  const interrupt = value => { signal = value; try { docker(['stop', '--time', '20', name], { stdio: 'ignore' }); } catch { /* The child may already have exited. */ } };
  const onInt = () => interrupt('SIGINT');
  const onTerm = () => interrupt('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  try {
    await mkdir(store, { recursive: true });
    await mkdir(join(runtime, 'config'), { recursive: true });
    await mkdir(join(runtime, 'cache'), { recursive: true });
    for (const [index, target] of (await workspaceModulePaths()).entries()) {
      const volume = `imagine-ci-deps-${id}-${index}`;
      docker(['volume', 'create', '--label', `org.imagine.ci.run=${id}`, volume], { stdio: 'ignore' });
      volumes.push(volume);
      mounts.push('--mount', `type=volume,src=${volume},dst=${target}`);
    }
    docker(['run', '--rm', '--env', `CI_UID=${uid}`, '--env', `CI_GID=${gid}`, ...mounts, identity.image, 'node', '-e',
      'const fs=require("node:fs"); for(const path of process.argv.slice(1)) fs.chownSync(path,Number(process.env.CI_UID),Number(process.env.CI_GID));',
      ...(await workspaceModulePaths())], { stdio: 'inherit' });
    const args = ['run', '--rm', '--init', '--name', name, '--network', 'host', '--ipc', 'host',
      '--user', `${uid}:${gid}`, '--group-add', String(socketGroup),
      '--mount', `type=bind,src=${root},dst=${root}`, '--mount', `type=bind,src=${runtime},dst=${runtime}`,
      '--mount', `type=bind,src=${socket},dst=/var/run/docker.sock`, ...mounts,
      '--workdir', root, '--env', 'CI=true', '--env', `TMPDIR=${runtime}`,
      '--env', `XDG_CONFIG_HOME=${runtime}/config`, '--env', `XDG_CACHE_HOME=${runtime}/cache`,
      '--env', `DOCKER_CONFIG=${runtime}/docker-config`, '--env', `pnpm_config_store_dir=${store}`,
      '--env', `IMAGINE_CI_PNPM_STORE=${store}`, '--env', 'npm_config_nodedir=/usr/local',
      '--env', `IMAGINE_CI_TOOLCHAIN=${identity.key}`];
    if (process.env.CI_BROWSER_CONCURRENCY !== undefined) args.push('--env', `CI_BROWSER_CONCURRENCY=${process.env.CI_BROWSER_CONCURRENCY}`);
    args.push(identity.image, 'sh', '-c', 'pnpm --store-dir "$IMAGINE_CI_PNPM_STORE" install --frozen-lockfile && node .github/scripts/ci.mjs "$@"', 'imagine-ci', options.scope);
    if (options.project) args.push(options.project);
    const code = await new Promise((yes, no) => {
      child = spawn('docker', args, { cwd: root, stdio: 'inherit' });
      child.once('error', no);
      child.once('exit', (code, termination) => termination ? no(new Error(`CI container exited with ${termination}.`)) : yes(code));
    });
    if (signal) throw new Error(`CI interrupted by ${signal}.`);
    if (code !== 0) throw new Error(`CI toolchain execution failed (${code}).`);
  } finally {
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
    try { await cleanupRuntime(name, volumes, runtime); }
    finally { await publishSummaries(beforeReports); }
  }
}

export async function main(args = process.argv.slice(2)) {
  const operation = args[0];
  const options = ['key', 'prepare'].includes(operation) && args.length === 1 ? null : ciOptions(args);
  const identity = await toolchainIdentity();
  if (operation === 'key' && options === null) { process.stdout.write(`key=${identity.key}\n`); return; }
  const receipt = { scope: options?.scope ?? operation, toolchain: identity.key, started: new Date().toISOString(), status: 'running' };
  const started = Date.now();
  try {
    await ensureImage(identity);
    receipt.prepareDurationMs = Date.now() - started;
    if (operation === 'prepare' && options === null) {
      await mkdir(cacheDirectory, { recursive: true });
      try { await stat(identity.archive); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const temporary = `${identity.archive}.${randomUUID()}.tmp`;
        try {
          const child = spawn('docker', ['save', identity.image], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
          const exited = new Promise((yes, no) => {
            child.once('error', no);
            child.once('exit', code => code === 0 ? yes() : no(new Error(`Docker save failed (${code}).`)));
          });
          await Promise.all([pipeline(child.stdout, createGzip({ level: 1 }), createWriteStream(temporary)), exited]);
          await rename(temporary, identity.archive);
        } finally { await rm(temporary, { force: true }); }
      }
      process.stdout.write(`CI toolchain archive ready: ${identity.key}\n`);
    } else await execute(identity, options);
    receipt.status = 'passed';
  } catch (error) {
    receipt.status = 'failed'; throw error;
  } finally {
    receipt.finished = new Date().toISOString(); receipt.durationMs = Date.now() - started;
    const directory = join(root, 'ci-results', 'toolchain-runs');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${randomUUID()}.json`);
    await writeFile(path, JSON.stringify(receipt, null, 2) + '\n');
    process.stdout.write(`CI toolchain ${receipt.status}; total ${(receipt.durationMs / 1000).toFixed(1)}s; receipt: ${path}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
