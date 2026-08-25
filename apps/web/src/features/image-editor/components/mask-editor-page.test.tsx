import { renderToStaticMarkup } from 'react-dom/server';
import * as Tooltip from '@radix-ui/react-tooltip';
import { createMaskDocument } from '@imagine/shared';
import type { AssetDto } from '@imagine/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  MaskEditorPage,
  MaskEditorStatus,
  clientPointIsInsideRect,
  contentRectToClientRect,
  uploadMaskAndContinue,
  type MaskEditorIntegration,
} from './mask-editor-page.js';
import { MaskEditorToolbar, type MaskEditorToolbarProps } from './mask-editor-toolbar.js';

function renderWithTooltips(node: React.ReactNode): string {
  return renderToStaticMarkup(<Tooltip.Provider>{node}</Tooltip.Provider>);
}

function toolbarProps(
  overrides: Partial<MaskEditorToolbarProps> = {},
): MaskEditorToolbarProps {
  return {
    applyDisabled: false,
    applying: false,
    canClear: true,
    canRedo: true,
    canUndo: true,
    clearConfirmation: false,
    diameter: 48,
    onApply: () => undefined,
    onCancelClear: () => undefined,
    onClose: () => undefined,
    onConfirmClear: () => undefined,
    onDiameterChange: () => undefined,
    onRedo: () => undefined,
    onRequestClear: () => undefined,
    onShowMaskChange: () => undefined,
    onShowOriginalChange: () => undefined,
    onToolChange: () => undefined,
    onUndo: () => undefined,
    showMask: true,
    showOriginal: true,
    tool: 'brush',
    ...overrides,
  };
}

const sourceAsset: AssetDto = {
  id: 'source-asset',
  jobId: null,
  parentAssetId: null,
  type: 'image',
  role: 'upload',
  contentUrl: '/internal/assets/source-asset/content',
  thumbnailUrl: '/internal/assets/source-asset/thumbnail',
  posterUrl: null,
  originalFilename: 'source.png',
  mimeType: 'image/png',
  width: 8,
  height: 6,
  durationMs: null,
  fileSize: 32,
  sha256: 'a'.repeat(64),
  metadata: {},
  favorite: false,
  collectionIds: [],
  createdAt: '2026-08-25T00:00:00.000Z',
};

const maskAsset: AssetDto = {
  ...sourceAsset,
  id: 'mask-asset',
  parentAssetId: sourceAsset.id,
  role: 'mask',
  contentUrl: '/internal/assets/mask-asset/content',
  thumbnailUrl: '/internal/assets/mask-asset/thumbnail',
  originalFilename: 'mask.png',
  sha256: 'b'.repeat(64),
};

describe('MaskEditorPage components', () => {
  it('renders stable toolbar commands, layer toggles, and inline clear confirmation', () => {
    const toolbar = renderWithTooltips(<MaskEditorToolbar {...toolbarProps()} />);
    for (const label of [
      'Brush',
      'Eraser',
      'Undo',
      'Redo',
      'Clear mask',
      'Cancel editing',
      'Apply mask',
    ]) {
      expect(toolbar).toContain(`aria-label="${label}"`);
    }
    expect(toolbar).toContain('aria-label="Brush size"');
    expect(toolbar).toContain('aria-label="Show mask overlay"');
    expect(toolbar).toContain('Original');
    expect(toolbar).toContain('Mask overlay');
    expect(toolbar).toContain('mask-editor-touch-target');

    const confirmation = renderWithTooltips(
      <MaskEditorToolbar {...toolbarProps({ clearConfirmation: true })} />,
    );
    expect(confirmation).toContain('Clear mask?');
    expect(confirmation).toContain('>Clear<');
    expect(confirmation).toContain('>Keep<');
  });

  it('renders typed loading and retryable error states without route hooks when integrated', () => {
    const integration: MaskEditorIntegration = {
      addComposerInput: () => undefined,
      assetId: 'source-asset',
      invalidateMedia: async () => undefined,
      navigate: () => undefined,
      setComposerExpanded: () => undefined,
      setComposerMode: () => undefined,
      setComposerPrimaryInput: () => undefined,
    };
    const page = renderWithTooltips(<MaskEditorPage integration={integration} />);
    expect(page).toContain('Loading image');

    const error = renderWithTooltips(
      <MaskEditorStatus
        error={{ code: 'asset_not_image', message: 'Only image assets can be edited.' }}
        message="Image editor unavailable"
        onClose={() => undefined}
        onRetry={() => undefined}
        status="error"
      />,
    );
    expect(error).toContain('data-error-code="asset_not_image"');
    expect(error).toContain('Only image assets can be edited.');
    expect(error).toContain('aria-label="Retry loading image"');
  });

  it('maps renderer-local content geometry into client coordinates', () => {
    const rect = contentRectToClientRect(
      { height: 50, left: 10, top: 20, width: 100 },
      { height: 300, left: 200, top: 100, width: 600 },
      { height: 150, width: 300 },
    );
    expect(rect).toEqual({ height: 100, left: 220, top: 140, width: 200 });
    expect(clientPointIsInsideRect({ x: 320, y: 190 }, rect)).toBe(true);
    expect(clientPointIsInsideRect({ x: 219, y: 190 }, rect)).toBe(false);
  });

  it('uploads then sets source and mask roles, invalidates media, and returns to Imagine', async () => {
    const events: string[] = [];
    const integration: MaskEditorIntegration = {
      addComposerInput: (input) => events.push(`add:${input.role}:${input.assetId}`),
      assetId: sourceAsset.id,
      invalidateMedia: async () => {
        events.push('invalidate');
      },
      navigate: (destination) => {
        events.push(`navigate:${destination}`);
      },
      setComposerExpanded: (expanded) => events.push(`expanded:${expanded}`),
      setComposerMode: (mode) => events.push(`mode:${mode}`),
      setComposerPrimaryInput: (input) => events.push(`primary:${input.role}:${input.assetId}`),
    };
    const uploadMask = vi.fn(async () => maskAsset);

    await expect(uploadMaskAndContinue({
      document: createMaskDocument({ height: 6, width: 8 }),
      integration,
      signal: new AbortController().signal,
      sourceAsset,
      uploadMask,
    })).resolves.toBe(maskAsset);
    expect(events).toEqual([
      'invalidate',
      'primary:source:source-asset',
      'add:mask:mask-asset',
      'mode:image',
      'expanded:true',
      'navigate:/imagine',
    ]);
  });

  it('does not update Composer state when apply is aborted before upload resolves', async () => {
    const controller = new AbortController();
    const setComposerPrimaryInput = vi.fn();
    const integration: MaskEditorIntegration = {
      addComposerInput: vi.fn(),
      assetId: sourceAsset.id,
      invalidateMedia: vi.fn(async () => undefined),
      navigate: vi.fn(),
      setComposerExpanded: vi.fn(),
      setComposerMode: vi.fn(),
      setComposerPrimaryInput,
    };
    const pending = uploadMaskAndContinue({
      document: createMaskDocument({ height: 6, width: 8 }),
      integration,
      signal: controller.signal,
      sourceAsset,
      uploadMask: async () => {
        controller.abort();
        return maskAsset;
      },
    });

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(setComposerPrimaryInput).not.toHaveBeenCalled();
    expect(integration.addComposerInput).not.toHaveBeenCalled();
  });
});
