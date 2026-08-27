import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { listenWithCleanup } from './index.js';

describe('server startup cleanup', () => {
  afterEach(() => vi.restoreAllMocks());

  it('closes the app exactly once when listen fails', async () => {
    const app = Fastify({ logger: false });
    const listenError = new Error('port is already in use');
    const listen = vi.spyOn(app, 'listen').mockRejectedValue(listenError);
    const close = vi.spyOn(app, 'close').mockImplementation(() => undefined);

    await expect(listenWithCleanup(app, { host: '0.0.0.0', port: 3030 })).rejects.toBe(listenError);
    expect(listen).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
