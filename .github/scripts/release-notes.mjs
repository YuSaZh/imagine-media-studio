import { readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

import { STABLE_RELEASE_TAG } from './release-guard.mjs';

const RELEASE_IMAGE = 'ghcr.io/yusazh/imagine-media-studio';
const RELEASE_NOTES_FILENAME = 'imagine-media-release-notes.md';
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatReleaseNotes(changelog, version, digest) {
  if (!STABLE_RELEASE_TAG.test(`v${version}`)) {
    throw new Error('Release notes require a stable semantic version.');
  }
  if (!DIGEST.test(digest)) {
    throw new Error('Release notes require an immutable SHA-256 image digest.');
  }

  const heading = new RegExp(`^## \\[${escapeRegex(version)}\\](?: - \\d{4}-\\d{2}-\\d{2})?\\s*$`, 'gmu');
  const matches = [...changelog.matchAll(heading)];
  if (matches.length !== 1 || matches[0]?.index === undefined) {
    throw new Error(`CHANGELOG must contain exactly one section for ${version}.`);
  }
  const bodyStart = matches[0].index + matches[0][0].length;
  const remainder = changelog.slice(bodyStart);
  const nextHeading = remainder.search(/^## /mu);
  const body = remainder.slice(0, nextHeading === -1 ? undefined : nextHeading).trim();
  if (body.length === 0) {
    throw new Error(`CHANGELOG section ${version} is empty.`);
  }

  return `${body}\n\n## Container image\n\n` +
    `Pull the tested multi-platform image by digest:\n\n` +
    `\`${RELEASE_IMAGE}@${digest}\`\n\n` +
    `Installation, upgrade, rollback, and attestation verification are documented in ` +
    `[RELEASE.md](https://github.com/YuSaZh/imagine-media-studio/blob/v${version}/RELEASE.md).\n`;
}

export function resolveTaskOwnedReleaseNotesPath(runnerTemp) {
  if (typeof runnerTemp !== 'string' || !isAbsolute(runnerTemp)) {
    throw new Error('RUNNER_TEMP must be an absolute directory.');
  }
  return resolve(runnerTemp, RELEASE_NOTES_FILENAME);
}

export async function cleanupReleaseNotes(runnerTemp) {
  await rm(resolveTaskOwnedReleaseNotesPath(runnerTemp), { force: true });
}

export async function main(args = process.argv.slice(2)) {
  const version = process.env.RELEASE_VERSION ?? '';
  const digest = process.env.RELEASE_DIGEST ?? '';
  const runnerTemp = process.env.RUNNER_TEMP ?? '';
  if (args.length === 1 && args[0] === '--cleanup') {
    await cleanupReleaseNotes(runnerTemp);
    return;
  }
  if (args.length !== 0) {
    throw new Error('Usage: release-notes.mjs [--cleanup]');
  }
  const changelog = await readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
  const notes = formatReleaseNotes(changelog, version, digest);
  await writeFile(resolveTaskOwnedReleaseNotesPath(runnerTemp), notes, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

if (import.meta.main) {
  await main();
}
