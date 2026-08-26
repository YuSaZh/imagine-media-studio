import { describe, expect, it } from 'vitest';

import { fileFingerprint } from './acquisition.js';
import { initialMediaInputState, mediaInputReducer } from './upload-reducer.js';

const file = new File(['image'], 'image.png', { lastModified: 1, type: 'image/png' });
const acquired = { clientId: 'client-1', file, fingerprint: fileFingerprint(file) };

describe('mediaInputReducer', () => {
  it('tracks the complete upload lifecycle and retry attempt', () => {
    let state = mediaInputReducer(initialMediaInputState, {
      acquired: [acquired],
      previewUrls: { 'client-1': 'blob:preview' },
      type: 'add',
    });
    expect(state.entries[0]).toMatchObject({ status: 'queued', role: 'reference' });
    state = mediaInputReducer(state, { clientId: 'client-1', type: 'preprocessing' });
    state = mediaInputReducer(state, { clientId: 'client-1', type: 'uploading' });
    state = mediaInputReducer(state, { clientId: 'client-1', error: 'offline', type: 'error' });
    expect(state.entries[0]).toMatchObject({ error: 'offline', status: 'error' });
    state = mediaInputReducer(state, { clientId: 'client-1', type: 'retry' });
    expect(state.entries[0]).toMatchObject({ attempt: 1, error: null, status: 'queued' });
    state = mediaInputReducer(state, {
      assetId: 'asset-1',
      clientId: 'client-1',
      inputDescriptor: { fileSize: 5, height: 1, mimeType: 'image/png', width: 1 },
      type: 'ready',
    });
    expect(state.entries[0]).toMatchObject({ assetId: 'asset-1', status: 'ready' });
  });

  it('persists the selected first-frame role on local upload entries', () => {
    const firstFrameAcquired = {
      ...acquired,
      clientId: 'client-first-frame',
    };
    const state = mediaInputReducer(initialMediaInputState, {
      acquired: [firstFrameAcquired],
      previewUrls: { [firstFrameAcquired.clientId]: 'blob:first-frame' },
      role: 'first_frame',
      type: 'add',
    });

    expect(state.entries[0]).toMatchObject({
      clientId: 'client-first-frame',
      role: 'first_frame',
    });
  });

  it('reports acquisition rejection and removes entries immutably', () => {
    const added = mediaInputReducer(initialMediaInputState, {
      acquired: [acquired],
      previewUrls: { 'client-1': 'blob:preview' },
      type: 'add',
    });
    const rejected = mediaInputReducer(added, {
      rejections: [{ name: 'bad.txt', reason: 'unsupported_type' }],
      type: 'reject',
    });
    expect(rejected.rejections).toHaveLength(1);
    const removed = mediaInputReducer(rejected, { clientId: 'client-1', type: 'remove' });
    expect(removed.entries).toEqual([]);
    expect(removed.rejections).toEqual([]);
    expect(added.entries).toHaveLength(1);

    const retried = mediaInputReducer(rejected, { clientId: 'client-1', type: 'retry' });
    expect(retried.rejections).toEqual([]);
  });
});
