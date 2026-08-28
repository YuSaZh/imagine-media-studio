import { readFile, stat } from 'node:fs/promises';
import process from 'node:process';
import { resolve } from 'node:path';

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const REQUIRED_PLATFORMS = ['linux/amd64', 'linux/arm64'];

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isoTimestamp(value) {
  if (
    !nonEmptyString(value) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  ) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function parseAttestationJson(source, label) {
  if (typeof source !== 'string' || source.trim() === '' || source.trim() === 'null') {
    throw new Error(`${label} JSON is empty or null.`);
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  return record(value, label);
}

export function validateReleaseAttestations(sbom, provenance) {
  const sbomPlatforms = record(sbom, 'SBOM');
  const provenancePlatforms = record(provenance, 'Provenance');
  for (const platform of REQUIRED_PLATFORMS) {
    const spdx = record(record(sbomPlatforms[platform], `${platform} SBOM`).SPDX, `${platform} SPDX`);
    if (
      spdx.SPDXID !== 'SPDXRef-DOCUMENT' ||
      typeof spdx.spdxVersion !== 'string' ||
      !spdx.spdxVersion.startsWith('SPDX-')
    ) {
      throw new Error(`${platform} SPDX payload has an unexpected shape.`);
    }
    const slsa = record(
      record(provenancePlatforms[platform], `${platform} provenance`).SLSA,
      `${platform} SLSA`,
    );
    const buildDefinition = record(slsa.buildDefinition, `${platform} SLSA buildDefinition`);
    const runDetails = record(slsa.runDetails, `${platform} SLSA runDetails`);
    const builder = record(runDetails.builder, `${platform} SLSA builder`);
    const metadata = record(runDetails.metadata, `${platform} SLSA metadata`);
    const startedOn = isoTimestamp(metadata.startedOn);
    const finishedOn = isoTimestamp(metadata.finishedOn);
    if (
      !nonEmptyString(buildDefinition.buildType) ||
      !nonEmptyString(builder.id) ||
      !nonEmptyString(metadata.invocationId) ||
      startedOn === null ||
      finishedOn === null ||
      finishedOn < startedOn
    ) {
      throw new Error(`${platform} SLSA v1 payload has an unexpected shape.`);
    }
  }
}

async function readBoundedJson(path, label) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_JSON_BYTES) {
    throw new Error(`${label} file must be a bounded non-empty regular file.`);
  }
  return parseAttestationJson(await readFile(path, 'utf8'), label);
}

function parseArguments(args) {
  if (args.length !== 4 || args[0] !== '--sbom' || args[2] !== '--provenance') {
    throw new Error('Usage: verify-release-attestations.mjs --sbom FILE --provenance FILE');
  }
  return { provenancePath: resolve(args[3]), sbomPath: resolve(args[1]) };
}

export async function main(args = process.argv.slice(2), output = process.stdout) {
  const { provenancePath, sbomPath } = parseArguments(args);
  const [sbom, provenance] = await Promise.all([
    readBoundedJson(sbomPath, 'SBOM'),
    readBoundedJson(provenancePath, 'Provenance'),
  ]);
  validateReleaseAttestations(sbom, provenance);
  output.write('amd64 and arm64 SPDX/SLSA attestations verified.\n');
}

if (import.meta.main) {
  await main();
}
