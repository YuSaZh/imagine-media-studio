/* global URL, console, process */

import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAIN_ENTRY_MAX_BYTES = 500_000;

const TAG_PATTERNS = {
  link: /<link\b[^>]*>/giu,
  script: /<script\b[^>]*>/giu,
};
const ATTRIBUTE_PATTERN = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu;
const PRECACHE_CALL_PATTERN = /precacheAndRoute\(\s*(\[[\s\S]*?\])\s*,/u;
const PRECACHE_URL_PATTERN = /(?:["']?url["']?)\s*:\s*(["'])(.*?)\1/gu;

async function listFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await listFiles(resolve(directory, entry.name), `${relativePath}/`));
    } else {
      files.push(relativePath);
    }
  }
  return files;
}

function attributesFromTag(tag) {
  const attributes = new Map();
  for (const match of tag.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4];
    if (name === undefined || value === undefined) continue;
    if (attributes.has(name)) throw new Error(`Build artifact budget: duplicate ${name} attribute.`);
    attributes.set(name, value);
  }
  return attributes;
}

function tagsFromHtml(html, tagName) {
  return [...html.matchAll(TAG_PATTERNS[tagName])].map((match) => match[0]);
}

function assetPathFromReference(reference, label) {
  const value = reference.trim();
  if (value === '') throw new Error(`Build artifact budget: ${label} is empty.`);
  if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/u.test(value)) {
    throw new Error(`Build artifact budget: ${label} must be a local asset path.`);
  }
  if (value.includes('?') || value.includes('#') || value.includes('\\')) {
    throw new Error(`Build artifact budget: ${label} must not contain a query, fragment, or backslash.`);
  }
  const path = value.startsWith('/') ? value.slice(1) : value.replace(/^\.\//u, '');
  if (!path.startsWith('assets/') || path.includes('..') || !path.endsWith('.js')) {
    throw new Error(`Build artifact budget: ${label} must point to a local assets/*.js file.`);
  }
  return path;
}

function precachePathFromUrl(url) {
  const value = url.trim();
  if (value === '' || /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/u.test(value)) {
    throw new Error('Build artifact budget: Service Worker precache contains a non-local URL.');
  }
  if (value.includes('?') || value.includes('#') || value.includes('\\')) {
    throw new Error('Build artifact budget: Service Worker precache URL contains a query, fragment, or backslash.');
  }
  const path = value.startsWith('/') ? value.slice(1) : value;
  if (path.includes('..')) {
    throw new Error('Build artifact budget: Service Worker precache URL escapes the build root.');
  }
  return path;
}

export function moduleEntryAssetsFromHtml(html) {
  const moduleScripts = tagsFromHtml(html, 'script')
    .map((tag) => attributesFromTag(tag))
    .filter((attributes) => attributes.get('type')?.toLowerCase() === 'module');
  if (moduleScripts.length !== 1) {
    throw new Error(
      `Build artifact budget: expected exactly one module entry script, found ${moduleScripts.length}.`,
    );
  }
  const src = moduleScripts[0]?.get('src');
  if (src === undefined) {
    throw new Error('Build artifact budget: module entry script has no src attribute.');
  }
  return [assetPathFromReference(src, 'module entry')];
}

export function entryAssetFromHtml(html) {
  return moduleEntryAssetsFromHtml(html)[0];
}

export function modulePreloadAssetsFromHtml(html) {
  return tagsFromHtml(html, 'link')
    .map((tag) => attributesFromTag(tag))
    .filter((attributes) => (attributes.get('rel') ?? '').toLowerCase().split(/\s+/u).includes('modulepreload'))
    .map((attributes) => {
      const href = attributes.get('href');
      if (href === undefined) throw new Error('Build artifact budget: modulepreload link has no href attribute.');
      return assetPathFromReference(href, 'modulepreload');
    });
}

export function precachedAssetUrlsFromServiceWorker(serviceWorker) {
  const manifestMatch = serviceWorker.match(PRECACHE_CALL_PATTERN);
  if (!manifestMatch?.[1]) {
    throw new Error('Build artifact budget: Service Worker has no precache manifest array.');
  }
  const urls = new Set();
  for (const match of manifestMatch[1].matchAll(PRECACHE_URL_PATTERN)) {
    const url = match[2];
    if (url === undefined) throw new Error('Build artifact budget: malformed precache URL entry.');
    urls.add(precachePathFromUrl(url));
  }
  if (urls.size === 0) {
    throw new Error('Build artifact budget: Service Worker precache manifest has no URL entries.');
  }
  return urls;
}

export async function inspectBuildArtifacts(distDirectory) {
  const html = await readFile(resolve(distDirectory, 'index.html'), 'utf8');
  const entryAsset = entryAssetFromHtml(html);
  const initialModulePreloads = modulePreloadAssetsFromHtml(html);
  const entryBytes = (await stat(resolve(distDirectory, entryAsset))).size;
  const files = await listFiles(distDirectory);
  const javascriptAssets = files.filter((file) => file.startsWith('assets/') && file.endsWith('.js'));
  const serviceWorker = await readFile(resolve(distDirectory, 'sw.js'), 'utf8');
  const precachedAssetUrls = precachedAssetUrlsFromServiceWorker(serviceWorker);
  const missingPrecache = javascriptAssets.filter((file) => !precachedAssetUrls.has(file));
  return {
    entryAsset,
    entryBytes,
    initialModulePreloads,
    javascriptAssets,
    missingPrecache,
    precachedAssetUrls,
  };
}

export async function assertBuildArtifactBudget({
  distDirectory,
  maxEntryBytes = MAIN_ENTRY_MAX_BYTES,
} = {}) {
  const resolvedDistDirectory = distDirectory ?? resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
  const result = await inspectBuildArtifacts(resolvedDistDirectory);
  if (result.entryBytes > maxEntryBytes) {
    throw new Error(
      `Build artifact budget exceeded: ${result.entryAsset} is ${result.entryBytes} bytes; ` +
      `maximum is ${maxEntryBytes} bytes.`,
    );
  }
  if (result.missingPrecache.length > 0) {
    throw new Error(
      `PWA precache is missing JavaScript assets: ${result.missingPrecache.join(', ')}.`,
    );
  }
  return result;
}

function formatBytes(bytes) {
  return `${(bytes / 1000).toFixed(2)} kB`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await assertBuildArtifactBudget();
  const preloads = result.initialModulePreloads.length > 0
    ? result.initialModulePreloads.join(', ')
    : 'none';
  console.log(
    `Build artifact budget passed: ${result.entryAsset} ${formatBytes(result.entryBytes)} ` +
    `<= ${formatBytes(MAIN_ENTRY_MAX_BYTES)}; initial modulepreload: ${preloads}; ` +
    `${result.javascriptAssets.length} JavaScript assets precached.`,
  );
}
