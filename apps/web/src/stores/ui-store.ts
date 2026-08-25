import { create } from 'zustand';

export type ComposerMode = 'image' | 'video';

export type GalleryFilter =
  | 'all'
  | 'image'
  | 'video'
  | 'in-progress'
  | 'failed'
  | 'favorites';

interface UiState {
  composerMode: ComposerMode;
  composerExpanded: boolean;
  composerParamsOpen: boolean;
  composerReferenceAssetIds: readonly string[];
  viewerAssetId: string | null;
  selectedAssetIds: ReadonlySet<string>;
  activeFolderId: string | null;
  activeFilter: GalleryFilter;
}

interface UiActions {
  setComposerMode: (mode: ComposerMode) => void;
  setComposerExpanded: (expanded: boolean) => void;
  toggleComposerExpanded: () => void;
  setComposerParamsOpen: (open: boolean) => void;
  addComposerReference: (assetId: string) => void;
  limitComposerReferences: (maximum: number) => void;
  removeComposerReference: (assetId: string) => void;
  openViewer: (assetId: string) => void;
  closeViewer: () => void;
  toggleAssetSelection: (assetId: string) => void;
  clearAssetSelection: () => void;
  setActiveFolder: (folderId: string | null) => void;
  setActiveFilter: (filter: GalleryFilter) => void;
  reset: () => void;
}

export type UiStore = UiState & UiActions;

function createInitialState(): UiState {
  return {
    composerMode: 'image',
    composerExpanded: false,
    composerParamsOpen: false,
    composerReferenceAssetIds: [],
    viewerAssetId: null,
    selectedAssetIds: new Set<string>(),
    activeFolderId: null,
    activeFilter: 'all',
  };
}

export const useUiStore = create<UiStore>()((set) => ({
  ...createInitialState(),
  setComposerMode: (composerMode) => set({ composerMode }),
  setComposerExpanded: (composerExpanded) => set({ composerExpanded }),
  toggleComposerExpanded: () =>
    set((state) => ({ composerExpanded: !state.composerExpanded })),
  setComposerParamsOpen: (composerParamsOpen) => set({ composerParamsOpen }),
  addComposerReference: (assetId) =>
    set((state) => ({
      composerReferenceAssetIds: state.composerReferenceAssetIds.includes(assetId)
        ? state.composerReferenceAssetIds
        : [...state.composerReferenceAssetIds, assetId].slice(-4),
    })),
  limitComposerReferences: (maximum) =>
    set((state) => ({
      composerReferenceAssetIds: state.composerReferenceAssetIds.slice(
        0,
        Math.max(0, Math.trunc(maximum)),
      ),
    })),
  removeComposerReference: (assetId) =>
    set((state) => ({
      composerReferenceAssetIds: state.composerReferenceAssetIds.filter((id) => id !== assetId),
    })),
  openViewer: (viewerAssetId) => set({ viewerAssetId }),
  closeViewer: () => set({ viewerAssetId: null }),
  toggleAssetSelection: (assetId) =>
    set((state) => {
      const selectedAssetIds = new Set(state.selectedAssetIds);
      if (selectedAssetIds.has(assetId)) {
        selectedAssetIds.delete(assetId);
      } else {
        selectedAssetIds.add(assetId);
      }
      return { composerParamsOpen: false, selectedAssetIds };
    }),
  clearAssetSelection: () => set({ selectedAssetIds: new Set<string>() }),
  setActiveFolder: (activeFolderId) =>
    set({ activeFolderId, selectedAssetIds: new Set<string>(), viewerAssetId: null }),
  setActiveFilter: (activeFilter) =>
    set({ activeFilter, selectedAssetIds: new Set<string>(), viewerAssetId: null }),
  reset: () => set(createInitialState()),
}));
