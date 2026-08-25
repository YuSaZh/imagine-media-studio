import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

describe('server configuration', () => {
  it('applies bounded media and network-safe defaults outside production', () => {
    const config = loadConfig({ DATA_DIR: '/tmp/imagine-config-test' });

    expect(config).toMatchObject({
      allowHttpMediaDownloads: false,
      allowInsecureProviderHttp: false,
      allowPrivateNetworkAccess: false,
      appPassword: null,
      maxImageUploadBytes: 32 * 1024 * 1024,
      maxVideoUploadBytes: 512 * 1024 * 1024,
      maxRemoteImageBytes: 64 * 1024 * 1024,
      maxRemoteVideoBytes: 1024 * 1024 * 1024,
      providerInputMaxBytesPerFile: 64 * 1024 * 1024,
      providerInputMaxTotalBytes: 256 * 1024 * 1024,
      mediaProcessTimeoutMs: 30_000,
      nodeEnvironment: 'development',
    });
  });

  it('rejects placeholder or short production secrets', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/APP_SECRET/);
    expect(() =>
      loadConfig({
        APP_SECRET: 'replace-with-a-long-random-secret',
        NODE_ENV: 'production',
      }),
    ).toThrow(/APP_SECRET/);
  });

  it('parses explicit production limits and safety switches', () => {
    const config = loadConfig({
      ALLOW_HTTP_MEDIA_DOWNLOADS: 'true',
      ALLOW_INSECURE_PROVIDER_HTTP: 'true',
      ALLOW_PRIVATE_NETWORK_ACCESS: 'true',
      APP_SECRET: 'a-production-secret-that-is-longer-than-32-characters',
      APP_PASSWORD: 'deployment-password',
      MAX_IMAGE_UPLOAD_BYTES: '1024',
      PROVIDER_INPUT_MAX_BYTES_PER_FILE: '2048',
      PROVIDER_INPUT_MAX_TOTAL_BYTES: '4096',
      NODE_ENV: 'production',
    });

    expect(config.allowHttpMediaDownloads).toBe(true);
    expect(config.allowInsecureProviderHttp).toBe(true);
    expect(config.allowPrivateNetworkAccess).toBe(true);
    expect(config.maxImageUploadBytes).toBe(1024);
    expect(config.providerInputMaxBytesPerFile).toBe(2048);
    expect(config.providerInputMaxTotalBytes).toBe(4096);
    expect(config.appPassword).toBe('deployment-password');
  });

  it('rejects an aggregate provider input limit below the per-file limit', () => {
    expect(() => loadConfig({
      PROVIDER_INPUT_MAX_BYTES_PER_FILE: '4096',
      PROVIDER_INPUT_MAX_TOTAL_BYTES: '1024',
    })).toThrow(/PROVIDER_INPUT_MAX_BYTES_PER_FILE/);
  });
});
