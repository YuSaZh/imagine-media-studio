import { describe, expect, it } from 'vitest';
import type { AssetRecord } from '../database/assets.js';
import { PublicInputLinks } from './public-input-links.js';
const asset = { id: 'image', type: 'image', sha256: 'hash', deletedAt: null } as AssetRecord;
describe('expiring provider image links', () => {
  it('binds signature to asset, digest, expiry and application secret', () => {
    let now = 1_900_000_000_000;
    const links = new PublicInputLinks('app-secret', 'https://studio.example', () => now);
    const [expires, signature] = new URL(links.create(asset)).pathname.split('/').slice(-2) as [string, string];
    expect(links.verify(asset, expires, signature)).toBe(true);
    expect(links.verify({ ...asset, id: 'other' }, expires, signature)).toBe(false);
    expect(links.verify({ ...asset, sha256: 'changed' }, expires, signature)).toBe(false);
    expect(links.verify({ ...asset, deletedAt: new Date() }, expires, signature)).toBe(false);
    expect(links.verify(asset, String(Number(expires) + 100), signature)).toBe(false);
    expect(new PublicInputLinks('other-secret', 'https://studio.example', () => now).verify(asset, expires, signature)).toBe(false);
    now += 900_000;
    expect(links.verify(asset, expires, signature)).toBe(false);
  });
});
