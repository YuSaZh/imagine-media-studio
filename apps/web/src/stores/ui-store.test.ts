import { beforeEach, describe, expect, it } from 'vitest';

import { useUiStore } from './ui-store.js';

beforeEach(() => {
  useUiStore.getState().reset();
});

describe('useUiStore', () => {
  it('switches composer mode and panel state', () => {
    const store = useUiStore.getState();

    store.setComposerMode('video');
    store.setComposerExpanded(true);
    store.setComposerParamsOpen(true);

    expect(useUiStore.getState()).toMatchObject({
      composerMode: 'video',
      composerExpanded: true,
      composerParamsOpen: true,
    });

    useUiStore.getState().toggleComposerExpanded();
    expect(useUiStore.getState().composerExpanded).toBe(false);
  });

  it('opens, moves, and closes the viewer', () => {
    useUiStore.getState().openViewer('asset-1');
    expect(useUiStore.getState()).toMatchObject({
      viewerAssetId: 'asset-1',
    });

    useUiStore.getState().addComposerReference('asset-1');
    useUiStore.getState().addComposerReference('asset-1');
    expect(useUiStore.getState().composerReferenceAssetIds).toEqual(['asset-1']);
    useUiStore.getState().addComposerReference('asset-2');
    useUiStore.getState().limitComposerReferences(1);
    expect(useUiStore.getState().composerReferenceAssetIds).toEqual(['asset-1']);
    useUiStore.getState().removeComposerReference('asset-1');
    expect(useUiStore.getState().composerReferenceAssetIds).toEqual([]);

    useUiStore.getState().closeViewer();
    expect(useUiStore.getState()).toMatchObject({
      viewerAssetId: null,
    });
  });

  it('updates multi-selection with immutable Set instances', () => {
    const initialSelection = useUiStore.getState().selectedAssetIds;

    useUiStore.getState().toggleAssetSelection('asset-1');
    const firstSelection = useUiStore.getState().selectedAssetIds;
    useUiStore.getState().toggleAssetSelection('asset-2');

    expect(firstSelection).not.toBe(initialSelection);
    expect([...useUiStore.getState().selectedAssetIds]).toEqual(['asset-1', 'asset-2']);

    useUiStore.getState().toggleAssetSelection('asset-1');
    expect([...useUiStore.getState().selectedAssetIds]).toEqual(['asset-2']);

    useUiStore.getState().clearAssetSelection();
    expect(useUiStore.getState().selectedAssetIds.size).toBe(0);
  });

  it('resets all transient state without replacing the actions', () => {
    const reset = useUiStore.getState().reset;
    useUiStore.getState().setComposerMode('video');
    useUiStore.getState().setComposerExpanded(true);
    useUiStore.getState().setComposerParamsOpen(true);
    useUiStore.getState().openViewer('asset-9');
    useUiStore.getState().addComposerReference('asset-9');
    useUiStore.getState().toggleAssetSelection('asset-9');
    useUiStore.getState().setActiveFolder('folder-2');
    useUiStore.getState().setActiveFilter('favorites');

    reset();

    expect(useUiStore.getState()).toMatchObject({
      composerMode: 'image',
      composerExpanded: false,
      composerParamsOpen: false,
      composerReferenceAssetIds: [],
      viewerAssetId: null,
      activeFolderId: null,
      activeFilter: 'all',
      reset,
    });
    expect(useUiStore.getState().selectedAssetIds.size).toBe(0);
  });
});
