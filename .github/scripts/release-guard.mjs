import { appendFile, readFile } from 'node:fs/promises';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const STABLE_SEMVER_SOURCE = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)';
const STABLE_SEMVER = new RegExp(`^${STABLE_SEMVER_SOURCE}$`, 'u');
export const STABLE_RELEASE_TAG = new RegExp(`^v${STABLE_SEMVER_SOURCE}$`, 'u');

export function validateReleaseTag(
  tag,
  packageVersion,
  ref = `refs/tags/${tag}`,
) {
  if (typeof tag !== 'string' || !STABLE_RELEASE_TAG.test(tag)) {
    throw new Error('Release ref must be a stable vX.Y.Z tag.');
  }
  if (typeof packageVersion !== 'string' || !STABLE_SEMVER.test(packageVersion)) {
    throw new Error('Root package version must be a stable semantic version.');
  }
  if (ref !== `refs/tags/${tag}`) {
    throw new Error('Release workflow must run from the pushed tag ref.');
  }
  if (tag !== `v${packageVersion}`) {
    throw new Error('Release tag must exactly match the root package version.');
  }
  return { tag, version: packageVersion };
}

export async function readRootPackageVersion(
  packagePath = new URL('../../package.json', import.meta.url),
) {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  return packageJson.version;
}

export async function main() {
  const tag = process.env.GITHUB_REF_NAME ?? '';
  const ref = process.env.GITHUB_REF ?? `refs/tags/${tag}`;
  const packageVersion = await readRootPackageVersion();
  const release = validateReleaseTag(tag, packageVersion, ref);
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath === undefined || outputPath.length === 0) {
    process.stdout.write(`Release tag validated: ${release.tag}\n`);
    return release;
  }
  await appendFile(outputPath, `tag=${release.tag}\nversion=${release.version}\n`);
  return release;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && fileURLToPath(import.meta.url) === resolve(entrypoint)) {
  await main();
}
