import { describe, expect, it } from 'vitest';

import {
  isIosDevice,
  isIosSafari,
  isStandaloneDisplayMode,
} from './use-runtime-state.js';

describe('runtime display detection', () => {
  it('recognizes iPhone/iPad Safari and iPadOS desktop user agents', () => {
    expect(isIosDevice({
      platform: 'iPhone',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
    })).toBe(true);
    expect(isIosSafari({
      platform: 'iPhone',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
    })).toBe(true);
    expect(isIosSafari({
      maxTouchPoints: 5,
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
    })).toBe(true);
    expect(isIosSafari({
      platform: 'iPhone',
      userAgent: 'Mozilla/5.0 CriOS/120.0 Mobile/15E148 Safari/604.1',
    })).toBe(false);
  });

  it('supports Safari navigator.standalone as well as the display-mode media query', () => {
    expect(isStandaloneDisplayMode(
      { matchMedia: () => ({ matches: false }) },
      { standalone: true },
    )).toBe(true);
    expect(isStandaloneDisplayMode(
      { matchMedia: () => ({ matches: true }) },
      { standalone: false },
    )).toBe(true);
    expect(isStandaloneDisplayMode(
      { matchMedia: () => ({ matches: false }) },
      { standalone: false },
    )).toBe(false);
  });
});
