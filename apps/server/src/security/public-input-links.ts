import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AssetRecord } from '../database/assets.js';

export class PublicInputLinks {
  constructor(private readonly secret: string, private readonly baseUrl: string | (() => string), private readonly now: () => number = Date.now, readonly ttlSeconds = 900) {}
  get enabled(): boolean { return !!(typeof this.baseUrl === 'function' ? this.baseUrl() : this.baseUrl); }
  private signature(asset: Pick<AssetRecord, 'id' | 'sha256'>, expires: number) {
    return createHmac('sha256', this.secret).update(JSON.stringify(['imagine-provider-input-v1', asset.id, asset.sha256, expires])).digest('base64url');
  }
  create(asset: AssetRecord): string {
    if (asset.type !== 'image' || asset.deletedAt !== null) throw new Error('Input image is unavailable.');
    const expires = Math.floor(this.now() / 1000) + this.ttlSeconds;
    const base = typeof this.baseUrl === 'function' ? this.baseUrl() : this.baseUrl;
    if (!base) throw new Error('Public input URL is not configured.');
    return `${base.replace(/\/$/, '')}/media-inputs/${encodeURIComponent(asset.id)}/${expires}/${this.signature(asset, expires)}`;
  }
  verify(asset: AssetRecord, expiresText: string, signature: string): boolean {
    if (asset.type !== 'image' || asset.deletedAt !== null || !/^\d{10,12}$/.test(expiresText) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
    const expires = Number(expiresText);
    const now = Math.floor(this.now() / 1000);
    if (expires <= now || expires > now + this.ttlSeconds) return false;
    return timingSafeEqual(Buffer.from(signature), Buffer.from(this.signature(asset, expires)));
  }
}
