import { create } from 'zustand';
import type { AssetInput } from '@imagine/shared';

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
  composerInputs: readonly AssetInput[];
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
  addComposerInput: (input: AssetInput) => void;
  setComposerInputs: (inputs: readonly AssetInput[]) => void;
  removeComposerInput: (input: AssetInput) => void;
  setComposerPrimaryInput: (input: AssetInput & { role: 'first_frame' | 'source' }) => void;
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
    composerInputs: [],
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
  setComposerInputs: (composerInputs) => set({ composerInputs: [...composerInputs] }),
  addComposerInput: (input) =>
    set((state) => {
      const sameAsset = state.composerInputs.find(
        (candidate) => candidate.assetId === input.assetId,
      );
      if (sameAsset?.role === input.role) return state;
      if (input.role === 'reference' && sameAsset !== undefined) return state;
      const withoutSameAsset = state.composerInputs.filter(
        (candidate) => candidate.assetId !== input.assetId,
      );
      return {
        composerInputs: ['first_frame', 'last_frame', 'mask', 'source'].includes(input.role)
          ? [...withoutSameAsset.filter((candidate) => candidate.role !== input.role), input]
          : [...withoutSameAsset, input],
      };
    }),
  removeComposerInput: (input) =>
    set((state) => ({
      composerInputs: state.composerInputs.filter(
        (candidate) => candidate.assetId !== input.assetId || candidate.role !== input.role,
      ),
    })),
  setComposerPrimaryInput: (input) =>
    set((state) => ({
      composerInputs: [
        ...state.composerInputs.filter(
          (candidate) =>
            candidate.assetId !== input.assetId &&
            !['first_frame', 'last_frame', 'mask', 'source'].includes(candidate.role),
        ),
        input,
      ],
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
