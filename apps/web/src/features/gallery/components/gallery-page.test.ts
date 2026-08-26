import { describe, expect, it } from 'vitest';

import { PR1_MOCK_VIDEO_ITEMS } from '../model/fixtures.js';
import { mediaDownloadTarget } from './gallery-page.js';

describe('Gallery media downloads', () => {
  it('downloads video content with an mp4 filename instead of its poster', () => {
    const target = mediaDownloadTarget({
      ...PR1_MOCK_VIDEO_ITEMS[0]!,
      sourcePath: '/mock-media/study-motion.mp4',
    });

    expect(target).toEqual({
      filename: 'video-01-video.mp4',
      href: '/mock-media/study-motion.mp4',
    });
  });

  it('does not create a download target for a video without content', () => {
    expect(mediaDownloadTarget({
      ...PR1_MOCK_VIDEO_ITEMS[0]!,
      sourcePath: null,
    })).toBeNull();
  });
});
