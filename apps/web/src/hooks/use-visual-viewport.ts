import { useEffect, useState } from 'react';

export const VISUAL_VIEWPORT_CSS_VARIABLES = [
  '--visual-viewport-width',
  '--visual-viewport-height',
  '--visual-viewport-offset-top',
  '--visual-viewport-offset-left',
  '--keyboard-offset',
  '--keyboard-open',
] as const;

export interface VisualViewportLike {
  readonly height: number;
  readonly offsetLeft: number;
  readonly offsetTop: number;
  readonly scale?: number;
  readonly width?: number;
  addEventListener: (type: 'resize' | 'scroll', listener: EventListener) => void;
  removeEventListener: (type: 'resize' | 'scroll', listener: EventListener) => void;
}

export interface VisualViewportWindowLike {
  readonly innerHeight: number;
  readonly innerWidth?: number;
  readonly navigator?: { readonly maxTouchPoints?: number };
  readonly document?: { readonly activeElement?: ActiveElementLike | null };
  readonly matchMedia?: (query: string) => Pick<MediaQueryList, 'matches'>;
  readonly visualViewport?: VisualViewportLike | null;
  readonly addEventListener?: (type: 'resize' | 'focusin' | 'focusout', listener: EventListener) => void;
  readonly removeEventListener?: (type: 'resize' | 'focusin' | 'focusout', listener: EventListener) => void;
}

export interface ActiveElementLike {
  readonly contentEditable?: string;
  readonly disabled?: boolean;
  readonly isContentEditable?: boolean;
  readonly readOnly?: boolean;
  readonly tagName?: string;
  readonly type?: string;
}

export interface VisualViewportHookOptions {
  readonly activeElement?: ActiveElementLike | null;
  readonly windowLike?: VisualViewportWindowLike | null;
}

export interface VisualViewportMetrics {
  readonly height: number;
  readonly width: number;
  readonly offsetLeft: number;
  readonly offsetTop: number;
  readonly keyboardOffset: number;
  readonly keyboardOpen: boolean;
}

export interface ViewportStyleTarget {
  setProperty: (property: string, value: string) => void;
  removeProperty: (property: string) => void;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: number): number {
  return Math.max(0, value);
}

export const KEYBOARD_MIN_HEIGHT_REDUCTION_PX = 120;
export const KEYBOARD_MIN_HEIGHT_REDUCTION_RATIO = 0.2;

export function isEditableActiveElement(
  activeElement: ActiveElementLike | null | undefined,
): boolean {
  if (!activeElement || activeElement.disabled || activeElement.readOnly) return false;
  if (activeElement.isContentEditable || activeElement.contentEditable === 'true') return true;
  const tagName = activeElement.tagName?.toUpperCase();
  if (tagName !== 'INPUT' && tagName !== 'TEXTAREA') return false;
  return activeElement.type?.toLowerCase() !== 'hidden';
}

export function isMobileOrCoarsePointer(
  windowLike: VisualViewportWindowLike | null | undefined,
): boolean {
  const pointerCoarse = windowLike?.matchMedia?.('(pointer: coarse)').matches === true ||
    windowLike?.matchMedia?.('(any-pointer: coarse)').matches === true;
  const mobileWidth = (windowLike?.innerWidth ?? 0) <= 720;
  const touchDevice = (windowLike?.navigator?.maxTouchPoints ?? 0) > 0;
  return pointerCoarse || mobileWidth || touchDevice;
}

export function keyboardHeightReduction(
  windowLike: VisualViewportWindowLike | null | undefined,
  viewport: VisualViewportLike | null | undefined,
): number {
  const innerHeight = nonNegative(finiteOr(windowLike?.innerHeight, 0));
  const height = nonNegative(finiteOr(viewport?.height, innerHeight));
  const offsetTop = nonNegative(finiteOr(viewport?.offsetTop, 0));
  return Math.max(0, innerHeight - height - offsetTop);
}

export function shouldTreatAsKeyboardOpen(
  windowLike: VisualViewportWindowLike | null | undefined,
  viewport: VisualViewportLike | null | undefined,
  activeElement: ActiveElementLike | null | undefined = windowLike?.document?.activeElement,
): boolean {
  if (!isMobileOrCoarsePointer(windowLike) || !isEditableActiveElement(activeElement)) return false;
  const scale = finiteOr(viewport?.scale, 1);
  if (scale !== 1) return false;
  const innerHeight = nonNegative(finiteOr(windowLike?.innerHeight, 0));
  const reduction = keyboardHeightReduction(windowLike, viewport);
  const threshold = Math.max(
    KEYBOARD_MIN_HEIGHT_REDUCTION_PX,
    innerHeight * KEYBOARD_MIN_HEIGHT_REDUCTION_RATIO,
  );
  return reduction > threshold;
}

export function readVisualViewportMetrics(
  windowLike: VisualViewportWindowLike | null | undefined,
  activeElement: ActiveElementLike | null | undefined = windowLike?.document?.activeElement,
): VisualViewportMetrics {
  const innerHeight = nonNegative(finiteOr(windowLike?.innerHeight, 0));
  const innerWidth = nonNegative(finiteOr(windowLike?.innerWidth, 0));
  const viewport = windowLike?.visualViewport ?? null;
  const height = nonNegative(finiteOr(viewport?.height, innerHeight));
  const width = nonNegative(finiteOr(viewport?.width, innerWidth));
  const offsetTop = nonNegative(finiteOr(viewport?.offsetTop, 0));
  const offsetLeft = nonNegative(finiteOr(viewport?.offsetLeft, 0));
  const keyboardOffset = shouldTreatAsKeyboardOpen(windowLike, viewport, activeElement)
    ? keyboardHeightReduction(windowLike, viewport)
    : 0;

  return {
    height,
    width,
    offsetLeft,
    offsetTop,
    keyboardOffset,
    keyboardOpen: keyboardOffset > 0,
  };
}

export function sameVisualViewportMetrics(
  first: VisualViewportMetrics,
  second: VisualViewportMetrics,
): boolean {
  return first.height === second.height &&
    first.width === second.width &&
    first.offsetLeft === second.offsetLeft &&
    first.offsetTop === second.offsetTop &&
    first.keyboardOffset === second.keyboardOffset &&
    first.keyboardOpen === second.keyboardOpen;
}

export function applyVisualViewportMetrics(
  target: ViewportStyleTarget,
  metrics: VisualViewportMetrics,
): void {
  target.setProperty('--visual-viewport-width', `${Math.round(metrics.width)}px`);
  target.setProperty('--visual-viewport-height', `${Math.round(metrics.height)}px`);
  target.setProperty('--visual-viewport-offset-top', `${Math.round(metrics.offsetTop)}px`);
  target.setProperty('--visual-viewport-offset-left', `${Math.round(metrics.offsetLeft)}px`);
  target.setProperty('--keyboard-offset', `${Math.round(metrics.keyboardOffset)}px`);
  target.setProperty('--keyboard-open', metrics.keyboardOpen ? '1' : '0');
}

function getBrowserWindow(): VisualViewportWindowLike | null {
  return typeof window === 'undefined' ? null : window;
}

export function useVisualViewport(
  options: VisualViewportHookOptions = {},
): VisualViewportMetrics {
  const configuredWindow = options.windowLike;
  const activeElementOverride = options.activeElement;
  const initialWindow = configuredWindow === undefined ? getBrowserWindow() : configuredWindow;
  const [metrics, setMetrics] = useState<VisualViewportMetrics>(() =>
    readVisualViewportMetrics(initialWindow, activeElementOverride));

  useEffect(() => {
    const windowLike = configuredWindow === undefined ? getBrowserWindow() : configuredWindow;
    if (!windowLike) return undefined;

    const style = document.documentElement.style;
    const previousValues = new Map<string, string>();
    for (const property of VISUAL_VIEWPORT_CSS_VARIABLES) {
      previousValues.set(property, style.getPropertyValue(property));
    }

    const update = () => {
      const next = readVisualViewportMetrics(windowLike, activeElementOverride);
      applyVisualViewportMetrics(style, next);
      setMetrics((current) => sameVisualViewportMetrics(current, next) ? current : next);
    };
    const viewport = windowLike.visualViewport;
    update();
    const listener = update as EventListener;
    windowLike.addEventListener?.('resize', listener);
    windowLike.addEventListener?.('focusin', listener);
    windowLike.addEventListener?.('focusout', listener);
    viewport?.addEventListener('resize', listener);
    viewport?.addEventListener('scroll', listener);

    return () => {
      windowLike.removeEventListener?.('resize', listener);
      windowLike.removeEventListener?.('focusin', listener);
      windowLike.removeEventListener?.('focusout', listener);
      viewport?.removeEventListener('resize', listener);
      viewport?.removeEventListener('scroll', listener);
      for (const property of VISUAL_VIEWPORT_CSS_VARIABLES) {
        const previous = previousValues.get(property) ?? '';
        if (previous) style.setProperty(property, previous);
        else style.removeProperty(property);
      }
    };
  }, [activeElementOverride, configuredWindow]);

  return metrics;
}
