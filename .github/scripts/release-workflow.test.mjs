import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';

import { validateReleaseTag } from './release-guard.mjs';

const requireFromServer = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const { parseDocument } = requireFromServer('yaml');

const workflowText = await readFile(new URL('../workflows/release.yml', import.meta.url), 'utf8');
const smokeScript = await readFile(new URL('./release-smoke.sh', import.meta.url), 'utf8');
const document = parseDocument(workflowText, { uniqueKeys: true });
assert.equal(document.errors.length, 0, document.errors.map((error) => error.message).join('; '));
const workflow = document.toJS();

assert.equal(workflow.name, 'Release');
assert.deepEqual(workflow.permissions, {});
assert.deepEqual(workflow.on.push.tags, ['v[0-9]+.[0-9]+.[0-9]+']);
assert.equal(workflow.on.workflow_dispatch, undefined);

const publish = workflow.jobs.publish;
const smoke = workflow.jobs.smoke;
assert.ok(publish);
assert.ok(smoke);
assert.deepEqual(publish.permissions, {
  attestations: 'write',
  'artifact-metadata': 'write',
  contents: 'read',
  'id-token': 'write',
  packages: 'write',
});
assert.deepEqual(smoke.permissions, { contents: 'read', packages: 'read' });
assert.equal(publish['runs-on'], 'ubuntu-24.04');
assert.equal(smoke['runs-on'], 'ubuntu-24.04');
assert.equal(smoke.needs, 'publish');
assert.equal(publish.outputs.digest, '${{ steps.push.outputs.digest }}');

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
  const expectedUses = ['actions/checkout', 'actions/setup-node', 'docker/login-action'].includes(reference.name) ? 2 : 1;
  assert.equal(matches.length, expectedUses, `Unexpected pin count for ${reference.name}.`);
  const ref = actionRef(reference);
  assert.ok(action(publish, ref), `Missing pinned ${ref} action in publish.`);
}
for (const reference of actionRefs.filter(({ name }) =>
  ['actions/checkout', 'actions/setup-node', 'docker/login-action'].includes(name))) {
  assert.ok(action(smoke, actionRef(reference)), `Missing pinned ${actionRef(reference)} action in smoke.`);
}

const checkoutRef = actionRef(actionRefs[0]);
const nodeRef = actionRef(actionRefs[1]);
const loginRef = actionRef(actionRefs[4]);
const metadataRef = actionRef(actionRefs[5]);
const buildRef = actionRef(actionRefs[6]);
const attestRef = actionRef(actionRefs[7]);

const guard = step(publish, (candidate) => candidate.id === 'release', 'release guard');
assert.equal(guard.run, 'node .github/scripts/release-guard.mjs');
const loginIndex = publish.steps.findIndex((candidate) => candidate.uses === loginRef);
const guardIndex = publish.steps.indexOf(guard);
assert.ok(guardIndex >= 0 && guardIndex < loginIndex, 'The tag/version gate must run before registry login.');

const metadata = action(publish, metadataRef);
assert.equal(metadata.with.images, '${{ env.IMAGE }}');
assert.equal(metadata.with.flavor, 'latest=false');
for (const tagRule of [
  'type=semver,pattern={{version}},value=${{ steps.release.outputs.version }}',
  'type=semver,pattern={{major}}.{{minor}},value=${{ steps.release.outputs.version }}',
  'type=raw,value=latest',
  'type=sha,format=long,prefix=sha-',
]) assert.ok(metadata.with.tags.includes(tagRule), `Missing metadata rule: ${tagRule}`);

const build = action(publish, buildRef);
assert.equal(build.with.context, '.');
assert.equal(build.with.platforms, 'linux/amd64,linux/arm64');
assert.equal(build.with.push, true);
assert.equal(build.with.tags, '${{ steps.meta.outputs.tags }}');
assert.equal(build.with.labels, '${{ steps.meta.outputs.labels }}');
assert.equal(build.with.sbom, true);
assert.equal(build.with.provenance, 'mode=max');
assert.ok(build.with['build-args'].includes("OCI_CREATED=${{ fromJSON(steps.meta.outputs.json).labels['org.opencontainers.image.created'] }}"));
assert.ok(build.with['build-args'].includes('OCI_VERSION=${{ steps.meta.outputs.version }}'));
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

const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
assert.equal(packageJson.version, '0.0.0');
assert.throws(() => validateReleaseTag('v1.2.3-rc.1', packageJson.version), /stable/);
assert.throws(() => validateReleaseTag('v0.1.0', packageJson.version), /exactly match/);
assert.throws(() => validateReleaseTag('v01.2.3', '01.2.3'), /stable/);
assert.throws(() => validateReleaseTag('v1.2.3', '1.2.3', 'refs/heads/main'), /pushed tag ref/);
assert.deepEqual(validateReleaseTag('v1.2.3', '1.2.3'), { tag: 'v1.2.3', version: '1.2.3' });
assert.match(smokeScript, /export IMAGINE_MEDIA_HOST_PORT="\$host_port"/);
assert.ok(smokeScript.indexOf('trap cleanup EXIT') < smokeScript.indexOf('mkdir -- "$data_directory"'));

process.stdout.write('release workflow structure and release guard checks passed\n');
