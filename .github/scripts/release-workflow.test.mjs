import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

import {
  readReleaseVersions,
  validateReleaseTag,
  validateReleaseVersions,
} from './release-guard.mjs';
import {
  formatReleaseNotes,
  resolveTaskOwnedReleaseNotesPath,
} from './release-notes.mjs';
import { publishGitHubRelease } from './release-publish.mjs';
import {
  main as verifyReleaseAttestationFiles,
  parseAttestationJson,
  validateReleaseAttestations,
} from './verify-release-attestations.mjs';

const requireFromServer = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const { parseDocument } = requireFromServer('yaml');

const workflowText = await readFile(new URL('../workflows/release.yml', import.meta.url), 'utf8');
const smokeScript = await readFile(new URL('./release-smoke.sh', import.meta.url), 'utf8');
const changelogText = await readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
const document = parseDocument(workflowText, { uniqueKeys: true });
assert.equal(document.errors.length, 0, document.errors.map((error) => error.message).join('; '));
const workflow = document.toJS();

assert.equal(workflow.name, 'Release');
assert.deepEqual(workflow.permissions, {});
assert.deepEqual(workflow.on.push.tags, ['v[0-9]+.[0-9]+.[0-9]+']);
assert.equal(workflow.on.workflow_dispatch, undefined);

const publish = workflow.jobs.publish;
const smoke = workflow.jobs.smoke;
const promote = workflow.jobs.promote;
const githubRelease = workflow.jobs['github-release'];
assert.ok(publish);
assert.ok(smoke);
assert.ok(promote);
assert.ok(githubRelease);
assert.deepEqual(publish.permissions, {
  attestations: 'write',
  'artifact-metadata': 'write',
  contents: 'read',
  'id-token': 'write',
  packages: 'write',
});
assert.deepEqual(smoke.permissions, { contents: 'read', packages: 'read' });
assert.deepEqual(promote.permissions, { packages: 'write' });
assert.deepEqual(githubRelease.permissions, { contents: 'write' });
assert.equal(publish['runs-on'], 'ubuntu-24.04');
assert.equal(smoke['runs-on'], 'ubuntu-24.04');
assert.equal(promote['runs-on'], 'ubuntu-24.04');
assert.equal(githubRelease['runs-on'], 'ubuntu-24.04');
assert.equal(smoke.needs, 'publish');
assert.deepEqual(promote.needs, ['publish', 'smoke']);
assert.deepEqual(githubRelease.needs, ['publish', 'smoke', 'promote']);
assert.match(promote.if, /needs\.smoke\.result == 'success'/u);
assert.match(githubRelease.if, /needs\.promote\.result == 'success'/u);
assert.equal(publish.outputs.digest, '${{ steps.push.outputs.digest }}');
assert.equal(workflow.concurrency.group, 'stable-release');
assert.equal(workflow.concurrency['cancel-in-progress'], false);
assert.doesNotMatch(workflowText, /\$\{\{\s*runner(?:\.|\[)/u);
const jobEnvContexts = new Set(['github', 'inputs', 'matrix', 'needs', 'secrets', 'strategy', 'vars']);
for (const [jobName, job] of Object.entries(workflow.jobs)) {
  for (const value of Object.values(job.env ?? {})) {
    for (const match of String(value).matchAll(/\$\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)/gu)) {
      assert.ok(
        jobEnvContexts.has(match[1]),
        `Context ${match[1]} is unavailable in jobs.${jobName}.env.`,
      );
    }
  }
}

const step = (job, predicate, label) => {
  const match = job.steps.find(predicate);
  assert.ok(match, `Missing ${label} step.`);
  return match;
};
const action = (job, uses) => step(
  job,
  (candidate) => typeof uses === 'string' ? candidate.uses === uses : uses.test(candidate.uses),
  String(uses),
);

const actionRefs = [
  { name: 'actions/checkout', version: 'v6', sha: 'd23441a48e516b6c34aea4fa41551a30e30af803' },
  { name: 'actions/setup-node', version: 'v5', sha: 'a0853c24544627f65ddf259abe73b1d18a591444' },
  { name: 'docker/setup-qemu-action', version: 'v4', sha: '96fe6ef7f33517b61c61be40b68a1882f3264fb8' },
  { name: 'docker/setup-buildx-action', version: 'v4', sha: '37fe631027851001ddb9b187196cc803df7f5f0e' },
  { name: 'docker/login-action', version: 'v4', sha: 'dbcb813823bdd20940b903addbd779551569679f' },
  { name: 'docker/metadata-action', version: 'v6', sha: 'dc802804100637a589fabce1cb79ff13a1411302' },
  { name: 'docker/build-push-action', version: 'v7', sha: '53b7df96c91f9c12dcc8a07bcb9ccacbed38856a' },
  { name: 'actions/attest', version: 'v4', sha: '1e69f48acb82d1966a394da916b4c1698aa569d6' },
];
const workflowRegexEscape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const actionRef = ({ name, sha }) => `${name}@${sha}`;
for (const reference of actionRefs) {
  const pattern = new RegExp(
    `${workflowRegexEscape(reference.name)}@${reference.sha} \\# ${workflowRegexEscape(reference.version)}`,
    'g',
  );
  const matches = workflowText.match(pattern) ?? [];
  const expectedUses = {
    'actions/checkout': 3,
    'actions/setup-node': 3,
    'docker/login-action': 3,
    'docker/setup-buildx-action': 2,
  }[reference.name] ?? 1;
  assert.equal(matches.length, expectedUses, `Unexpected pin count for ${reference.name}.`);
  const ref = actionRef(reference);
  assert.ok(action(publish, ref), `Missing pinned ${ref} action in publish.`);
}
for (const reference of actionRefs.filter(({ name }) =>
  ['actions/checkout', 'actions/setup-node', 'docker/login-action'].includes(name))) {
  assert.ok(action(smoke, actionRef(reference)), `Missing pinned ${actionRef(reference)} action in smoke.`);
}
assert.ok(action(promote, actionRef(actionRefs[3])));
assert.ok(action(promote, actionRef(actionRefs[4])));
assert.ok(action(githubRelease, actionRef(actionRefs[0])));
assert.ok(action(githubRelease, actionRef(actionRefs[1])));

for (const job of Object.values(workflow.jobs)) {
  for (const workflowStep of job.steps) {
    if (workflowStep.uses !== undefined) {
      assert.match(workflowStep.uses, /^[^@]+@[a-f0-9]{40}$/u, `Action is not pinned: ${workflowStep.uses}`);
    }
  }
}

const checkoutRef = actionRef(actionRefs[0]);
const nodeRef = actionRef(actionRefs[1]);
const loginRef = actionRef(actionRefs[4]);
const metadataRef = actionRef(actionRefs[5]);
const buildRef = actionRef(actionRefs[6]);
const attestRef = actionRef(actionRefs[7]);
for (const [jobName, job] of [
  ['publish', publish],
  ['smoke', smoke],
  ['github-release', githubRelease],
]) {
  const setupNode = action(job, nodeRef);
  assert.equal(setupNode.with['node-version'], 24, `${jobName} must use Node.js 24.`);
  assert.equal(
    setupNode.with['package-manager-cache'],
    false,
    `${jobName} must disable setup-node automatic package-manager caching.`,
  );
}
assert.doesNotMatch(workflowText, /pnpm\/action-setup@/u);

const guard = step(publish, (candidate) => candidate.id === 'release', 'release guard');
assert.equal(guard.run, 'node .github/scripts/release-guard.mjs');
const loginIndex = publish.steps.findIndex((candidate) => candidate.uses === loginRef);
const guardIndex = publish.steps.indexOf(guard);
assert.ok(guardIndex >= 0 && guardIndex < loginIndex, 'The tag/version gate must run before registry login.');

const metadata = action(publish, metadataRef);
assert.equal(metadata.with.images, '${{ env.IMAGE }}');
assert.equal(metadata.with.flavor, 'latest=false');
assert.equal(
  metadata.with.tags,
  'type=raw,value=candidate-sha-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
);
assert.equal(metadata.with.labels, 'org.opencontainers.image.version=${{ steps.release.outputs.version }}');
assert.doesNotMatch(JSON.stringify(publish), /type=semver|value=latest|prefix=sha-/u);

const build = action(publish, buildRef);
assert.equal(build.with.context, '.');
assert.equal(build.with.platforms, 'linux/amd64,linux/arm64');
assert.equal(build.with.push, true);
assert.equal(build.with.tags, '${{ steps.meta.outputs.tags }}');
assert.equal(build.with.labels, '${{ steps.meta.outputs.labels }}');
assert.equal(build.with.sbom, true);
assert.equal(build.with.provenance, 'mode=max');
assert.ok(build.with['build-args'].includes("OCI_CREATED=${{ fromJSON(steps.meta.outputs.json).labels['org.opencontainers.image.created'] }}"));
assert.ok(build.with['build-args'].includes('OCI_VERSION=${{ steps.release.outputs.version }}'));
assert.ok(build.with['build-args'].includes('OCI_REVISION=${{ github.sha }}'));

const attest = action(publish, attestRef);
assert.equal(attest.with['subject-name'], '${{ env.IMAGE }}');
assert.equal(attest.with['subject-digest'], '${{ steps.push.outputs.digest }}');
assert.equal(attest.with['push-to-registry'], true);

assert.equal(smoke.env.RELEASE_DIGEST, '${{ needs.publish.outputs.digest }}');
assert.equal(
  smoke.env.RELEASE_IMAGE,
  'ghcr.io/yusazh/imagine-media-studio@${{ needs.publish.outputs.digest }}',
);
assert.equal(step(smoke, (candidate) => candidate.run === 'bash .github/scripts/release-smoke.sh', 'release smoke').run, 'bash .github/scripts/release-smoke.sh');
assert.ok(action(smoke, checkoutRef));
assert.ok(action(smoke, nodeRef));
assert.ok(action(smoke, loginRef));

const promotion = step(
  promote,
  (candidate) => candidate.run?.includes('docker buildx imagetools create'),
  'digest promotion',
);
assert.equal(promote.env.RELEASE_DIGEST, '${{ needs.publish.outputs.digest }}');
assert.equal(promote.env.RELEASE_VERSION, '${{ needs.publish.outputs.version }}');
for (const expected of [
  '--tag "$IMAGE:$RELEASE_VERSION"',
  '--tag "$IMAGE:$minor_version"',
  '--tag "$IMAGE:latest"',
  '--tag "$IMAGE:sha-$GITHUB_SHA"',
  '"$IMAGE@$RELEASE_DIGEST"',
]) assert.ok(promotion.run.includes(expected), `Missing promotion argument: ${expected}`);
assert.ok(promotion.run.includes("metadata?.['containerimage.descriptor']?.digest"));
assert.doesNotMatch(JSON.stringify(smoke), /IMAGE:latest|type=semver/u);
assert.deepEqual(
  Object.entries(workflow.jobs)
    .filter(([, job]) => job.steps.some((candidate) => candidate.run?.includes('--tag "$IMAGE:latest"')))
    .map(([jobName]) => jobName),
  ['promote'],
  'The mutable latest image tag must exist only in the post-smoke promotion job.',
);

const prepareNotes = step(
  githubRelease,
  (candidate) => candidate.run === 'node .github/scripts/release-notes.mjs',
  'release notes preparation',
);
assert.ok(prepareNotes);
const publishRelease = step(
  githubRelease,
  (candidate) => candidate.run === 'node .github/scripts/release-publish.mjs',
  'idempotent GitHub Release publication',
);
assert.equal(publishRelease.env.GH_TOKEN, '${{ github.token }}');
assert.doesNotMatch(publishRelease.run, /GH_TOKEN|gh release (?:create|edit)/u);
const cleanupNotes = step(
  githubRelease,
  (candidate) => candidate.run === 'node .github/scripts/release-notes.mjs --cleanup',
  'release notes cleanup',
);
assert.equal(cleanupNotes.if, 'always()');
assert.equal(githubRelease.steps.at(-1), cleanupNotes);
assert.equal(githubRelease.env.RELEASE_DIGEST, '${{ needs.publish.outputs.digest }}');
assert.equal(githubRelease.env.RELEASE_VERSION, '${{ needs.publish.outputs.version }}');
assert.equal(githubRelease.env.RELEASE_NOTES_PATH, undefined);

const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const serverPackageJson = JSON.parse(await readFile(new URL('../../apps/server/package.json', import.meta.url), 'utf8'));
const webPackageJson = JSON.parse(await readFile(new URL('../../apps/web/package.json', import.meta.url), 'utf8'));
const releaseVersions = await readReleaseVersions();
assert.equal(packageJson.version, '0.1.2');
assert.equal(serverPackageJson.version, packageJson.version);
assert.equal(webPackageJson.version, packageJson.version);
assert.deepEqual(releaseVersions, {
  appInfo: '0.1.2',
  root: '0.1.2',
  server: '0.1.2',
  web: '0.1.2',
});
assert.equal(validateReleaseVersions(releaseVersions), packageJson.version);
for (const field of ['appInfo', 'server', 'web']) {
  assert.throws(
    () => validateReleaseVersions({ ...releaseVersions, [field]: '0.1.1' }),
    /must match exactly/u,
  );
}
assert.throws(
  () => validateReleaseVersions({ ...releaseVersions, appInfo: '0.1.0-beta.1' }),
  /stable semantic versions/u,
);
assert.throws(() => validateReleaseTag('v1.2.3-rc.1', packageJson.version), /stable/);
assert.throws(() => validateReleaseTag('v0.1.1', packageJson.version), /exactly match/);
assert.throws(() => validateReleaseTag('v01.2.3', '01.2.3'), /stable/);
assert.throws(() => validateReleaseTag('v1.2.3', '1.2.3', 'refs/heads/main'), /pushed tag ref/);
assert.deepEqual(validateReleaseTag('v1.2.3', '1.2.3'), { tag: 'v1.2.3', version: '1.2.3' });
assert.deepEqual(validateReleaseTag('v0.1.2', packageJson.version), { tag: 'v0.1.2', version: '0.1.2' });

const releaseDigest = `sha256:${'a'.repeat(64)}`;
const releaseNotes = formatReleaseNotes(changelogText, packageJson.version, releaseDigest);
assert.match(releaseNotes, /Remember image\/video model selections/u);
assert.match(releaseNotes, new RegExp(releaseDigest, 'u'));
assert.match(releaseNotes, /blob\/v0\.1\.2\/RELEASE\.md/u);
assert.doesNotMatch(releaseNotes, /\[Unreleased\]/u);
assert.throws(() => formatReleaseNotes(changelogText, '0.1.1', releaseDigest), /exactly one section/u);
assert.throws(() => formatReleaseNotes(changelogText, packageJson.version, 'sha256:bad'), /immutable/u);

const notesOuter = await mkdtemp(join(tmpdir(), 'imagine-release-notes-test-'));
try {
  const runnerTemp = join(notesOuter, 'runner');
  const notesPath = resolveTaskOwnedReleaseNotesPath(runnerTemp);
  assert.equal(notesPath, join(runnerTemp, 'imagine-media-release-notes.md'));
  assert.throws(() => resolveTaskOwnedReleaseNotesPath('relative/runner'), /absolute/u);
  await mkdir(runnerTemp, { mode: 0o700 });
  const notesScript = fileURLToPath(new URL('./release-notes.mjs', import.meta.url));
  const notesEnvironment = {
    ...process.env,
    RELEASE_DIGEST: releaseDigest,
    RELEASE_VERSION: packageJson.version,
    RUNNER_TEMP: runnerTemp,
  };
  const notesResult = spawnSync(process.execPath, [notesScript], {
    encoding: 'utf8',
    env: notesEnvironment,
  });
  assert.equal(notesResult.status, 0, `${notesResult.stdout}${notesResult.stderr}`);
  assert.equal((await stat(notesPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(notesPath, 'utf8'), releaseNotes);

  const publishOptions = {
    digest: releaseDigest,
    repository: 'YuSaZh/imagine-media-studio',
    runnerTemp,
    tag: 'v0.1.0',
    version: '0.1.0',
  };
  const createCalls = [];
  assert.deepEqual(await publishGitHubRelease({
    ...publishOptions,
    runGh: async (args) => {
      createCalls.push(args);
      return { status: 0, stdout: '' };
    },
  }), { created: true });
  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0]?.slice(0, 3), ['release', 'create', 'v0.1.0']);
  assert.ok(createCalls[0]?.includes('--verify-tag'));
  assert.ok(createCalls[0]?.includes('--latest'));
  assert.equal(createCalls[0]?.at(-1), notesPath);

  const matchingRelease = JSON.stringify({
    body: releaseNotes,
    isDraft: false,
    isPrerelease: false,
    name: 'Imagine Media Studio v0.1.0',
    tagName: 'v0.1.0',
  });
  const ambiguousResponses = [
    { status: 1, stdout: '' },
    { status: 0, stdout: matchingRelease },
    { status: 0, stdout: JSON.stringify({ tagName: 'v0.1.0' }) },
  ];
  assert.deepEqual(await publishGitHubRelease({
    ...publishOptions,
    runGh: async () => ambiguousResponses.shift(),
  }), { created: false });
  assert.equal(ambiguousResponses.length, 0);

  const mismatchResponses = [
    { status: 1, stdout: '' },
    { status: 0, stdout: JSON.stringify({
      ...JSON.parse(matchingRelease),
      body: `${releaseNotes}unexpected`,
    }) },
    { status: 0, stdout: JSON.stringify({ tagName: 'v0.1.0' }) },
  ];
  await assert.rejects(
    publishGitHubRelease({
      ...publishOptions,
      runGh: async () => mismatchResponses.shift(),
    }),
    /does not exactly match/u,
  );

  const notLatestResponses = [
    { status: 1, stdout: '' },
    { status: 0, stdout: matchingRelease },
    { status: 0, stdout: JSON.stringify({ tagName: 'v0.0.9' }) },
  ];
  await assert.rejects(
    publishGitHubRelease({
      ...publishOptions,
      runGh: async () => notLatestResponses.shift(),
    }),
    /does not exactly match/u,
  );

  const failedViewResponses = [
    { status: 1, stdout: '' },
    { status: 1, stdout: '' },
  ];
  await assert.rejects(
    publishGitHubRelease({
      ...publishOptions,
      runGh: async () => failedViewResponses.shift(),
    }),
    /could not be read/u,
  );

  const cleanupResult = spawnSync(process.execPath, [notesScript, '--cleanup'], {
    encoding: 'utf8',
    env: notesEnvironment,
  });
  assert.equal(cleanupResult.status, 0, `${cleanupResult.stdout}${cleanupResult.stderr}`);
  await assert.rejects(readFile(notesPath), { code: 'ENOENT' });
} finally {
  await rm(notesOuter, { force: true, recursive: true });
}

const spdxPayload = {
  SPDXID: 'SPDXRef-DOCUMENT',
  spdxVersion: 'SPDX-2.3',
};
const slsaPayload = {
  buildDefinition: {
    buildType: 'https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md',
  },
  runDetails: {
    builder: { id: 'https://github.com/YuSaZh/imagine-media-studio/actions/runs/33214299163' },
    metadata: {
      finishedOn: '2026-08-29T06:30:01Z',
      invocationId: 'buildkit-v0.1.0-test',
      startedOn: '2026-08-29T06:30:00Z',
    },
  },
};
const validSbom = {
  'linux/amd64': { SPDX: spdxPayload },
  'linux/arm64': { SPDX: spdxPayload },
};
const validProvenance = {
  'linux/amd64': { SLSA: slsaPayload },
  'linux/arm64': { SLSA: slsaPayload },
};
assert.doesNotThrow(() => validateReleaseAttestations(validSbom, validProvenance));
assert.throws(() => parseAttestationJson('null', 'SBOM'), /empty or null/u);
assert.throws(
  () => validateReleaseAttestations(
    { 'linux/amd64': validSbom['linux/amd64'] },
    validProvenance,
  ),
  /linux\/arm64 SBOM/u,
);
assert.throws(
  () => validateReleaseAttestations(
    validSbom,
    { 'linux/amd64': validProvenance['linux/amd64'] },
  ),
  /linux\/arm64 provenance/u,
);
const legacySlsa = {
  builder: { id: 'https://github.com/docker/build-push-action' },
  buildType: 'https://mobyproject.org/buildkit@v1',
};
assert.throws(
  () => validateReleaseAttestations(validSbom, {
    ...validProvenance,
    'linux/amd64': { SLSA: legacySlsa },
  }),
  /linux\/amd64 SLSA buildDefinition/u,
);
assert.throws(
  () => validateReleaseAttestations(validSbom, {
    ...validProvenance,
    'linux/amd64': { SLSA: { buildDefinition: slsaPayload.buildDefinition } },
  }),
  /linux\/amd64 SLSA runDetails/u,
);
assert.throws(
  () => validateReleaseAttestations(validSbom, {
    ...validProvenance,
    'linux/amd64': {
      SLSA: {
        ...slsaPayload,
        runDetails: {
          ...slsaPayload.runDetails,
          builder: { id: '' },
        },
      },
    },
  }),
  /linux\/amd64 SLSA v1 payload/u,
);
assert.throws(
  () => validateReleaseAttestations(validSbom, {
    ...validProvenance,
    'linux/amd64': {
      SLSA: {
        ...slsaPayload,
        runDetails: { ...slsaPayload.runDetails, metadata: null },
      },
    },
  }),
  /linux\/amd64 SLSA metadata/u,
);
for (const metadata of [
  { ...slsaPayload.runDetails.metadata, invocationId: '' },
  {
    finishedOn: slsaPayload.runDetails.metadata.finishedOn,
    invocationID: 'legacy-field-name',
    startedOn: slsaPayload.runDetails.metadata.startedOn,
  },
  { ...slsaPayload.runDetails.metadata, startedOn: 'not-an-iso-timestamp' },
  {
    ...slsaPayload.runDetails.metadata,
    finishedOn: '2026-08-29T06:29:59Z',
  },
]) {
  assert.throws(
    () => validateReleaseAttestations(validSbom, {
      ...validProvenance,
      'linux/amd64': {
        SLSA: {
          ...slsaPayload,
          runDetails: { ...slsaPayload.runDetails, metadata },
        },
      },
    }),
    /linux\/amd64 SLSA v1 payload/u,
  );
}
const attestationRoot = await mkdtemp(join(tmpdir(), 'imagine-release-attestations-test-'));
try {
  const sbomPath = join(attestationRoot, 'sbom.json');
  const provenancePath = join(attestationRoot, 'provenance.json');
  await Promise.all([
    writeFile(sbomPath, JSON.stringify(validSbom), { mode: 0o600 }),
    writeFile(provenancePath, JSON.stringify(validProvenance), { mode: 0o600 }),
  ]);
  let verificationOutput = '';
  await verifyReleaseAttestationFiles(
    ['--sbom', sbomPath, '--provenance', provenancePath],
    { write: (value) => { verificationOutput += value; } },
  );
  assert.match(verificationOutput, /amd64 and arm64 SPDX\/SLSA attestations verified/u);
} finally {
  await rm(attestationRoot, { force: true, recursive: true });
}
assert.match(smokeScript, /export IMAGINE_MEDIA_HOST_PORT="\$host_port"/);
assert.ok(smokeScript.indexOf('trap cleanup EXIT') < smokeScript.indexOf('mkdir -- "$data_directory"'));

const negativeRoot = await mkdtemp(join(tmpdir(), 'imagine-pr8-seed-guard-'));
try {
  const dataRoot = join(negativeRoot, 'live-data');
  const wrongRoot = join(negativeRoot, 'wrong-data');
  const fakeBin = join(negativeRoot, 'bin');
  const dockerLog = join(negativeRoot, 'docker.log');
  await Promise.all([
    mkdir(dataRoot, { mode: 0o700 }),
    mkdir(wrongRoot, { mode: 0o700 }),
    mkdir(fakeBin, { mode: 0o700 }),
  ]);
  await chmod(negativeRoot, 0o700);
  const fakeDocker = join(fakeBin, 'docker');
  await writeFile(
    fakeDocker,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [[ "$*" == 'compose config --format json' ]]; then
  printf '%s\\n' "$FAKE_COMPOSE_CONFIG"
  exit 0
fi
exit 91
`,
    { mode: 0o700 },
  );
  const composeConfig = JSON.stringify({
    services: {
      'imagine-media': {
        volumes: [{ source: wrongRoot, target: '/data', type: 'bind' }],
      },
    },
  });
  const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
  const seedScript = fileURLToPath(new URL('./pr8-legacy-seed.sh', import.meta.url));
  const result = spawnSync('bash', [seedScript], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      COMPOSE_PROJECT_NAME: 'imagine-pr8-seed-guard-test',
      DATA_HOST_DIR: dataRoot,
      FAKE_COMPOSE_CONFIG: composeConfig,
      FAKE_DOCKER_LOG: dockerLog,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      SMOKE_TASK_ROOT: negativeRoot,
    },
  });
  assert.notEqual(result.status, 0, 'A mismatched /data bind source must fail closed.');
  assert.match(`${result.stdout}${result.stderr}`, /bind source does not match DATA_HOST_DIR/u);
  assert.deepEqual((await readFile(dockerLog, 'utf8')).trim().split('\n'), ['compose config --format json']);
  assert.equal(
    (await readdir(negativeRoot)).some((name) => name.startsWith('.pr8-legacy-seed-config.')),
    false,
    'The task-owned structured config file must be removed after rejection.',
  );
} finally {
  await rm(negativeRoot, { force: true, recursive: true });
}

process.stdout.write('release workflow structure and release guard checks passed\n');
