import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { VIDEO_PLACEHOLDER_PATH } from '../../gallery/model/api-mapper.js';
import {
  formatViewerTime,
  isNativeMediaInteractionTarget,
  isViewerGestureInteractionTarget,
  shouldHandleViewerDoubleClick,
  VideoPreview,
} from './media-viewer.js';

describe('VideoPreview', () => {
  it('recognizes video and native control event targets before viewer navigation', () => {
    const videoTarget = { tagName: 'VIDEO' } as unknown as EventTarget;
    const controlTarget = {
      closest: (selectors: string) => selectors.includes('input[type="range"]') ? {} : null,
    } as unknown as EventTarget;
    const dialogTarget = { closest: () => null } as unknown as EventTarget;

    expect(isNativeMediaInteractionTarget(videoTarget)).toBe(true);
    expect(isNativeMediaInteractionTarget(controlTarget)).toBe(true);
    expect(isNativeMediaInteractionTarget(dialogTarget)).toBe(false);
    expect(isNativeMediaInteractionTarget(null)).toBe(false);
  });

  it('keeps Viewer controls out of the gesture stream while allowing image surfaces', () => {
    const buttonTarget = {
      closest: (selectors: string) => selectors.includes('button') ? {} : null,
    } as unknown as EventTarget;
    const imageTarget = {
      closest: () => null,
    } as unknown as EventTarget;

    expect(isViewerGestureInteractionTarget(buttonTarget)).toBe(true);
    expect(isViewerGestureInteractionTarget(imageTarget)).toBe(false);
    expect(isViewerGestureInteractionTarget({ tagName: 'VIDEO' } as unknown as EventTarget)).toBe(true);
    expect(shouldHandleViewerDoubleClick('image', imageTarget)).toBe(true);
    expect(shouldHandleViewerDoubleClick('image', buttonTarget)).toBe(false);
    expect(shouldHandleViewerDoubleClick('video', imageTarget)).toBe(false);
  });

  it('formats metadata time as a compact deterministic UTC value', () => {
    expect(formatViewerTime('2026-08-24T18:30:00.000Z')).toBe('2026-08-24 18:30 UTC');
    expect(formatViewerTime('not-a-timestamp')).toBe('not-a-timestamp');
  });

  it('renders native, keyboard-accessible video controls with bounded media URLs', () => {
    const markup = renderToStaticMarkup(createElement(VideoPreview, {
      alt: 'A moving study',
      errorMessage: null,
      onError: vi.fn(),
      posterPath: '/mock-media/study-01-portrait.png',
      sourcePath: '/mock-media/study-motion.mp4',
    }));

    expect(markup).toContain('<video');
    expect(markup).toContain('controls=""');
    expect(markup).toContain('playsInline=""');
    expect(markup).toContain('preload="metadata"');
    expect(markup).toContain('poster="/mock-media/study-01-portrait.png"');
    expect(markup).toContain('src="/mock-media/study-motion.mp4"');
  });

  it('uses the neutral poster fallback and exposes playback errors', () => {
    const fallbackMarkup = renderToStaticMarkup(createElement(VideoPreview, {
      alt: 'Fallback study',
      errorMessage: null,
      onError: vi.fn(),
      posterPath: '',
      sourcePath: '/mock-media/study-motion.mp4',
    }));
    expect(fallbackMarkup).toContain(`poster="${VIDEO_PLACEHOLDER_PATH}"`);

    const errorMarkup = renderToStaticMarkup(createElement(VideoPreview, {
      alt: 'Broken study',
      errorMessage: 'The video could not be loaded.',
      onError: vi.fn(),
      posterPath: '/mock-media/study-01-portrait.png',
      sourcePath: '/mock-media/study-motion.mp4',
    }));
    expect(errorMarkup).toContain('role="alert"');
    expect(errorMarkup).toContain('The video could not be loaded.');
    expect(errorMarkup).not.toContain('<video');
  });
});
