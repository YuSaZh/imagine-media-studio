import { appendFile, readFile } from 'node:fs/promises';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const STABLE_SEMVER_SOURCE = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)';
const STABLE_SEMVER = new RegExp(`^${STABLE_SEMVER_SOURCE}$`, 'u');
export const STABLE_RELEASE_TAG = new RegExp(`^v${STABLE_SEMVER_SOURCE}$`, 'u');
const APP_VERSION_SOURCE = /^export const APP_VERSION = '([^']+)' as const;\n$/u;

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

export function validateReleaseVersions(versions) {
  const entries = Object.entries(versions);
  const keys = entries.map(([key]) => key).sort();
  if (
    keys.join(',') !== 'appInfo,root,server,web' ||
    !entries.every(
      ([, version]) => typeof version === 'string' && STABLE_SEMVER.test(version),
    )
  ) {
    throw new Error('Release-facing versions must all be stable semantic versions.');
  }
  const rootVersion = versions.root;
  if (entries.some(([, version]) => version !== rootVersion)) {
    throw new Error('Root, server, web, and app-info versions must match exactly.');
  }
  return rootVersion;
}

export async function readReleaseVersions(paths = {
  appVersion: new URL('../../apps/server/src/version.ts', import.meta.url),
  root: new URL('../../package.json', import.meta.url),
  server: new URL('../../apps/server/package.json', import.meta.url),
  web: new URL('../../apps/web/package.json', import.meta.url),
}) {
  const [rootSource, serverSource, webSource, appVersionSource] = await Promise.all([
    readFile(paths.root, 'utf8'),
    readFile(paths.server, 'utf8'),
    readFile(paths.web, 'utf8'),
    readFile(paths.appVersion, 'utf8'),
  ]);
  const appVersionMatch = APP_VERSION_SOURCE.exec(appVersionSource);
  if (appVersionMatch === null) {
    throw new Error('The app-info version source has an unexpected shape.');
  }
  return {
    appInfo: appVersionMatch[1],
    root: JSON.parse(rootSource).version,
    server: JSON.parse(serverSource).version,
    web: JSON.parse(webSource).version,
  };
}

export async function main() {
  const tag = process.env.GITHUB_REF_NAME ?? '';
  const ref = process.env.GITHUB_REF ?? `refs/tags/${tag}`;
  const versions = await readReleaseVersions();
  const packageVersion = validateReleaseVersions(versions);
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
