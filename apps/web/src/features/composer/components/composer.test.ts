import { describe, expect, it } from 'vitest';

import { PR1_MOCK_PROVIDER } from '../../gallery/model/fixtures.js';
import {
  promptAfterSuccessfulSubmit,
  promptAfterSuccessfulSubmitSnapshot,
  supportedVideoInputModes,
  uploadRoleForMode,
} from './composer.js';

describe('Composer video input capabilities', () => {
  it('exposes only operations declared by the selected video model', () => {
    const model = PR1_MOCK_PROVIDER.models.find((candidate) => candidate.mediaKind === 'video');

    expect(supportedVideoInputModes(model)).toEqual(['text', 'first_frame', 'references']);
    expect(supportedVideoInputModes({
      ...model!,
      capabilities: {
        ...model!.capabilities,
        operations: ['video.generate'],
      },
    })).toEqual(['text']);
  });

  it('does not invent video inputs when the model has no video capability', () => {
    const model = PR1_MOCK_PROVIDER.models.find((candidate) => candidate.mediaKind === 'image');
    expect(supportedVideoInputModes(model)).toEqual([]);
    expect(supportedVideoInputModes(undefined)).toEqual([]);
  });

  it('keeps the upload role aligned with the selected video input mode', () => {
    expect(uploadRoleForMode('video', 'first_frame')).toBe('first_frame');
    expect(uploadRoleForMode('video', 'references')).toBe('reference');
    expect(uploadRoleForMode('video', 'text')).toBe('reference');
    expect(uploadRoleForMode('image', 'first_frame')).toBe('reference');
  });

  it('clears or retains the prompt according to the submit setting', () => {
    expect(promptAfterSuccessfulSubmit('keep this prompt', false)).toBe('keep this prompt');
    expect(promptAfterSuccessfulSubmit('clear this prompt', true)).toBe('');
  });

  it('keeps a prompt edited while a deferred submission is in flight', () => {
    expect(promptAfterSuccessfulSubmitSnapshot('A', 'A', true)).toBe('');
    expect(promptAfterSuccessfulSubmitSnapshot('A', 'A', false)).toBe('A');
    expect(promptAfterSuccessfulSubmitSnapshot('B', 'A', true)).toBe('B');
    expect(promptAfterSuccessfulSubmitSnapshot('B', 'A', false)).toBe('B');
  });
});
