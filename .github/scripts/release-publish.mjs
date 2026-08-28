import { Buffer } from 'node:buffer';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import process from 'node:process';
import { promisify } from 'node:util';

import { validateReleaseTag } from './release-guard.mjs';
import { resolveTaskOwnedReleaseNotesPath } from './release-notes.mjs';

const execFile = promisify(execFileCallback);
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_NOTES_BYTES = 1024 * 1024;

async function defaultRunGh(args) {
  try {
    const { stdout } = await execFile('gh', args, {
      encoding: 'utf8',
      env: process.env,
      maxBuffer: MAX_JSON_BYTES,
    });
    return { status: 0, stdout };
  } catch {
    return { status: 1, stdout: '' };
  }
}

function parseExactJson(source, keys, label) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_JSON_BYTES) {
    throw new Error(`${label} JSON is missing or too large.`);
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${label} did not return valid JSON.`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} JSON must be an object.`);
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  if (actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`${label} JSON has an unexpected shape.`);
  }
  return value;
}

export function validateExistingRelease({
  digest,
  expectedBody,
  expectedName,
  latestJson,
  releaseJson,
  tag,
}) {
  const release = parseExactJson(
    releaseJson,
    ['body', 'isDraft', 'isPrerelease', 'name', 'tagName'],
    'Existing release',
  );
  const latest = parseExactJson(latestJson, ['tagName'], 'Latest release');
  if (
    release.tagName !== tag ||
    release.name !== expectedName ||
    release.isDraft !== false ||
    release.isPrerelease !== false ||
    release.body !== expectedBody ||
    latest.tagName !== tag ||
    !release.body.includes(digest)
  ) {
    throw new Error('Existing GitHub Release does not exactly match the requested release.');
  }
}

export async function publishGitHubRelease({
  digest,
  ref,
  repository,
  runGh = defaultRunGh,
  runnerTemp,
  tag,
  version,
}) {
  validateReleaseTag(tag, version, ref ?? `refs/tags/${tag}`);
  if (!DIGEST.test(digest)) {
    throw new Error('GitHub Release requires an immutable SHA-256 image digest.');
  }
  if (!REPOSITORY.test(repository)) {
    throw new Error('GITHUB_REPOSITORY has an unexpected shape.');
  }
  const safeNotesPath = resolveTaskOwnedReleaseNotesPath(runnerTemp);
  const notesStat = await lstat(safeNotesPath);
  if (!notesStat.isFile() || notesStat.isSymbolicLink() ||
      (notesStat.mode & 0o777) !== 0o600 || notesStat.size > MAX_NOTES_BYTES) {
    throw new Error('Release notes must be a bounded 0600 regular file.');
  }
  const expectedBody = await readFile(safeNotesPath, 'utf8');
  if (!expectedBody.includes(digest)) {
    throw new Error('Release notes do not contain the current image digest.');
  }
  const expectedName = `Imagine Media Studio ${tag}`;
  const create = await runGh([
    'release', 'create', tag,
    '--repo', repository,
    '--verify-tag',
    '--latest',
    '--title', expectedName,
    '--notes-file', safeNotesPath,
  ]);
  if (create.status === 0) {
    return { created: true };
  }

  const existing = await runGh([
    'release', 'view', tag,
    '--repo', repository,
    '--json', 'tagName,name,isDraft,isPrerelease,body',
  ]);
  if (existing.status !== 0) {
    throw new Error('GitHub Release creation failed and the existing release could not be read.');
  }
  const latest = await runGh([
    'release', 'view',
    '--repo', repository,
    '--json', 'tagName',
  ]);
  if (latest.status !== 0) {
    throw new Error('GitHub Release creation failed and the latest release could not be read.');
  }
  validateExistingRelease({
    digest,
    expectedBody,
    expectedName,
    latestJson: latest.stdout,
    releaseJson: existing.stdout,
    tag,
  });
  return { created: false };
}

export async function main() {
  if ((process.env.GH_TOKEN ?? '').length === 0) {
    throw new Error('GH_TOKEN is required to publish or verify the GitHub Release.');
  }
  const result = await publishGitHubRelease({
    digest: process.env.RELEASE_DIGEST ?? '',
    ref: process.env.GITHUB_REF ?? '',
    repository: process.env.GITHUB_REPOSITORY ?? '',
    runnerTemp: process.env.RUNNER_TEMP ?? '',
    tag: process.env.GITHUB_REF_NAME ?? '',
    version: process.env.RELEASE_VERSION ?? '',
  });
  process.stdout.write(result.created
    ? 'GitHub Release created.\n'
    : 'Existing GitHub Release verified as identical.\n');
}

if (import.meta.main) {
  await main();
}
