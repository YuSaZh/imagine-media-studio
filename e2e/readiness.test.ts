import { describe, expect, it, vi } from 'vitest';

import {
  READINESS_ATTEMPTS,
  READINESS_REQUEST_TIMEOUT_MS,
  READINESS_RETRY_DELAY_MS,
  waitForServer,
} from './readiness.js';

describe('Playwright server readiness', () => {
  it('uses a bounded request timeout and returns on the first healthy response', async () => {
    const get = vi.fn().mockResolvedValue({ ok: () => true, status: () => 200 });
    const wait = vi.fn().mockResolvedValue(undefined);

    await waitForServer({ get }, wait);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/internal/auth/status', {
      timeout: READINESS_REQUEST_TIMEOUT_MS,
    });
    expect(wait).not.toHaveBeenCalled();
  });

  it('keeps failed readiness bounded to the configured attempts and retry period', async () => {
    const get = vi.fn().mockResolvedValue({ ok: () => false, status: () => 503 });
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(waitForServer({ get }, wait)).rejects.toThrow(
      'The Playwright webServer did not become ready (last status 503).',
    );

    expect(get).toHaveBeenCalledTimes(READINESS_ATTEMPTS);
    expect(get).toHaveBeenLastCalledWith('/internal/auth/status', {
      timeout: READINESS_REQUEST_TIMEOUT_MS,
    });
    expect(wait).toHaveBeenCalledTimes(READINESS_ATTEMPTS);
    expect(wait).toHaveBeenLastCalledWith(READINESS_RETRY_DELAY_MS);
  });
});
