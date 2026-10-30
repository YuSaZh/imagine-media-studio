import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { toolchainIdentity } from './ci-toolchain.mjs';

export async function testCiToolchain() {
  const identity = await toolchainIdentity();
  assert.match(identity.key, /^linux-(?:amd64|arm64)-[a-f0-9]{64}$/u);
  assert.notEqual((await toolchainIdentity('x64')).key, (await toolchainIdentity('arm64')).key);
  await assert.rejects(() => toolchainIdentity('unknown'), /supports x64 and arm64/u);
  const temporary = await mkdtemp(join(tmpdir(), 'imagine-ci-toolchain-test-'));
  try {
    const log = join(temporary, 'commands.jsonl');
    const socket = join(temporary, 'docker.sock');
    await writeFile(socket, 'fixture');
    await writeFile(join(temporary, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CI_TOOLCHAIN_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'image') process.stdout.write(process.env.CI_EXPECTED_TOOLCHAIN);
if (args[0] === 'run' && args.includes('--init')) process.exit(Number(process.env.CI_TOOLCHAIN_FAILURE ?? 0));
`, { mode: 0o700 });
    for (const failure of [0, 17]) {
      await writeFile(log, '');
      const result = spawnSync(process.execPath, ['.github/scripts/ci-toolchain.mjs', 'quality'], {
        encoding: 'utf8', timeout: 30000,
        env: { ...process.env, PATH: `${temporary}:${process.env.PATH}`, DOCKER_HOST: `unix://${socket}`,
          CI_TOOLCHAIN_LOG: log, CI_EXPECTED_TOOLCHAIN: identity.key, CI_TOOLCHAIN_FAILURE: String(failure),
          GH_TOKEN: 'fixture-must-not-reach-container' },
      });
      assert.equal(result.status, failure ? 1 : 0, result.stderr);
      const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const execution = calls.find(args => args[0] === 'run' && args.includes('--init'));
      assert.ok(execution);
      assert.equal(execution.at(-1), 'quality');
      assert.ok(execution.includes(`IMAGINE_CI_TOOLCHAIN=${identity.key}`));
      assert.ok(execution.includes('pnpm --store-dir "$IMAGINE_CI_PNPM_STORE" install --frozen-lockfile && node .github/scripts/ci.mjs "$@"'));
      assert.ok(!execution.some(arg => arg.includes('GH_TOKEN') || arg.includes('fixture-must-not-reach-container')));
      const created = calls.filter(args => args[0] === 'volume' && args[1] === 'create').map(args => args.at(-1));
      const removed = calls.filter(args => args[0] === 'volume' && args[1] === 'rm').map(args => args.at(-1));
      assert.ok(created.length >= 6);
      assert.deepEqual(removed, created);
      assert.ok(created.every(name => /^imagine-ci-deps-[a-f0-9-]+-\d+$/u.test(name)));
      assert.ok(calls.some(args => args[0] === 'rm' && args.at(-1).startsWith('imagine-ci-toolchain-')));
      assert.ok(!calls.some(args => args.includes('prune')));
    }
    await writeFile(log, '');
    const mismatch = spawnSync(process.execPath, ['.github/scripts/ci-toolchain.mjs', 'quality'], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PATH: `${temporary}:${process.env.PATH}`, CI_TOOLCHAIN_LOG: log, CI_EXPECTED_TOOLCHAIN: 'wrong-fingerprint' },
    });
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /does not match its content fingerprint/u);
    assert.ok(!(await readFile(log, 'utf8')).includes('"run"'), 'A mismatching image must never execute.');
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
