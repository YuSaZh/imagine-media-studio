import { describe, expect, it } from 'vitest';

import {
  applyVisualViewportMetrics,
  isEditableActiveElement,
  isMobileOrCoarsePointer,
  readVisualViewportMetrics,
  sameVisualViewportMetrics,
  shouldTreatAsKeyboardOpen,
  type ViewportStyleTarget,
  type VisualViewportMetrics,
} from './use-visual-viewport.js';

function metrics(overrides: Partial<VisualViewportMetrics> = {}): VisualViewportMetrics {
  return {
    height: 844,
    width: 390,
    offsetLeft: 0,
    offsetTop: 0,
    keyboardOffset: 0,
    keyboardOpen: false,
    ...overrides,
  };
}

function styleTarget(): ViewportStyleTarget & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    removeProperty(property) {
      values.delete(property);
    },
    setProperty(property, value) {
      values.set(property, value);
    },
  };
}

describe('visual viewport runtime adapter', () => {
  it('normalizes viewport dimensions and derives keyboard occlusion', () => {
    expect(readVisualViewportMetrics({
      innerHeight: 844,
      innerWidth: 390,
      navigator: { maxTouchPoints: 5 },
      document: { activeElement: { tagName: 'TEXTAREA' } },
      matchMedia: () => ({ matches: true }),
      visualViewport: {
        height: 584,
        width: 376,
        offsetLeft: 8,
        offsetTop: 12,
        scale: 1,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    })).toEqual({
      height: 584,
      width: 376,
      offsetLeft: 8,
      offsetTop: 12,
      keyboardOffset: 248,
      keyboardOpen: true,
    });
  });

  it('falls back to the layout viewport when visualViewport is unavailable', () => {
    expect(readVisualViewportMetrics({ innerHeight: 800, innerWidth: 360 })).toEqual({
      height: 800,
      width: 360,
      offsetLeft: 0,
      offsetTop: 0,
      keyboardOffset: 0,
      keyboardOpen: false,
    });
    expect(readVisualViewportMetrics(null)).toEqual({
      height: 0,
      width: 0,
      offsetLeft: 0,
      offsetTop: 0,
      keyboardOffset: 0,
      keyboardOpen: false,
    });
  });

  it('requires a focused editable control and a plausible mobile keyboard resize', () => {
    const mobileWindow = {
      innerHeight: 844,
      innerWidth: 390,
      navigator: { maxTouchPoints: 5 },
      document: { activeElement: { tagName: 'TEXTAREA' } },
      matchMedia: () => ({ matches: true }),
      visualViewport: {
        height: 584,
        width: 390,
        offsetLeft: 0,
        offsetTop: 0,
        scale: 1,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    };
    expect(isMobileOrCoarsePointer(mobileWindow)).toBe(true);
    expect(isEditableActiveElement(mobileWindow.document.activeElement)).toBe(true);
    expect(readVisualViewportMetrics(mobileWindow).keyboardOpen).toBe(true);
    expect(readVisualViewportMetrics({
      ...mobileWindow,
      document: { activeElement: null },
    }).keyboardOpen).toBe(false);
  });

  it('does not mistake address-bar changes, zoom, or a fine-pointer resize for a keyboard', () => {
    const editable = { tagName: 'INPUT', type: 'text' };
    const baseViewport = {
      height: 700,
      width: 390,
      offsetLeft: 0,
      offsetTop: 0,
      scale: 1,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    expect(shouldTreatAsKeyboardOpen({
      innerHeight: 844,
      innerWidth: 390,
      document: { activeElement: editable },
      matchMedia: () => ({ matches: true }),
      visualViewport: baseViewport,
    }, baseViewport)).toBe(false);
    expect(shouldTreatAsKeyboardOpen({
      innerHeight: 844,
      innerWidth: 390,
      document: { activeElement: editable },
      matchMedia: () => ({ matches: true }),
      visualViewport: { ...baseViewport, height: 584, scale: 2 },
    }, { ...baseViewport, height: 584, scale: 2 })).toBe(false);
    expect(shouldTreatAsKeyboardOpen({
      innerHeight: 844,
      innerWidth: 1024,
      document: { activeElement: editable },
      matchMedia: () => ({ matches: false }),
      visualViewport: { ...baseViewport, height: 584 },
    }, { ...baseViewport, height: 584 })).toBe(false);
  });

  it('does not derive keyboard occlusion from horizontal viewport offset', () => {
    const viewport = {
      height: 844,
      width: 374,
      offsetLeft: 8,
      offsetTop: 0,
      scale: 1,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const next = readVisualViewportMetrics({
      innerHeight: 844,
      innerWidth: 390,
      document: { activeElement: { tagName: 'TEXTAREA' } },
      matchMedia: () => ({ matches: true }),
      visualViewport: viewport,
    });
    expect(next.offsetLeft).toBe(8);
    expect(next.keyboardOffset).toBe(0);
    expect(next.keyboardOpen).toBe(false);
  });

  it('writes all viewport metrics without invoking scroll or focus APIs', () => {
    const target = styleTarget();
    applyVisualViewportMetrics(target, metrics({
      height: 560,
      width: 374,
      offsetLeft: 10,
      offsetTop: 20,
      keyboardOffset: 264,
      keyboardOpen: true,
    }));
    expect(Object.fromEntries(target.values)).toEqual({
      '--visual-viewport-width': '374px',
      '--visual-viewport-height': '560px',
      '--visual-viewport-offset-top': '20px',
      '--visual-viewport-offset-left': '10px',
      '--keyboard-offset': '264px',
      '--keyboard-open': '1',
    });
  });

  it('compares all dimensions so keyboard close and horizontal panning restore state', () => {
    expect(sameVisualViewportMetrics(metrics(), metrics())).toBe(true);
    expect(sameVisualViewportMetrics(metrics(), metrics({ offsetLeft: 1 }))).toBe(false);
    expect(sameVisualViewportMetrics(metrics({ keyboardOpen: true, keyboardOffset: 1 }), metrics())).toBe(false);
  });
});
