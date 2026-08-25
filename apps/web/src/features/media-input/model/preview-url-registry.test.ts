import { describe, expect, it, vi } from 'vitest';

import { PreviewUrlRegistry } from './preview-url-registry.js';

describe('PreviewUrlRegistry', () => {
  it('revokes replaced, removed, and remaining URLs exactly once', () => {
    const revoke = vi.fn();
    let sequence = 0;
    const registry = new PreviewUrlRegistry({
      create: () => `blob:${sequence += 1}`,
      revoke,
    });
    const file = new File(['image'], 'image.png', { type: 'image/png' });
    expect(registry.create('one', file)).toBe('blob:1');
    expect(registry.create('one', file)).toBe('blob:2');
    registry.create('two', file);
    registry.release('one');
    registry.dispose();
    registry.dispose();
    expect(revoke.mock.calls).toEqual([['blob:1'], ['blob:2'], ['blob:3']]);
  });

  it('rolls back every URL created before a batch failure', () => {
    const revoke = vi.fn();
    let sequence = 0;
    const registry = new PreviewUrlRegistry({
      create: () => {
        sequence += 1;
        if (sequence === 2) throw new Error('Preview unavailable');
        return `blob:${sequence}`;
      },
      revoke,
    });
    const file = new File(['image'], 'image.png', { type: 'image/png' });

    expect(() => registry.createBatch([
      { clientId: 'one', file },
      { clientId: 'two', file },
    ])).toThrow('Preview unavailable');
    registry.dispose();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:1');
  });
});
