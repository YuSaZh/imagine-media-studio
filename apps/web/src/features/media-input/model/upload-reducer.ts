import type {
  AcquiredImage,
  AcquisitionRejection,
  MediaInputState,
  ReferenceUploadRole,
  UploadEntry,
} from './types.js';

export type MediaInputAction =
  | {
      acquired: readonly AcquiredImage[];
      previewUrls: Readonly<Record<string, string>>;
      role?: ReferenceUploadRole;
      type: 'add';
    }
  | {
      assetId: string;
      clientId: string;
      inputDescriptor: UploadEntry['inputDescriptor'];
      type: 'ready';
    }
  | { clientId: string; error: string; type: 'error' }
  | { clientId: string; type: 'preprocessing' | 'remove' | 'retry' | 'uploading' }
  | { rejections: readonly AcquisitionRejection[]; type: 'reject' };

export const initialMediaInputState: MediaInputState = { entries: [], rejections: [] };

function updateEntry(
  entries: readonly UploadEntry[],
  clientId: string,
  update: (entry: UploadEntry) => UploadEntry,
): readonly UploadEntry[] {
  return entries.map((entry) => entry.clientId === clientId ? update(entry) : entry);
}

export function mediaInputReducer(
  state: MediaInputState,
  action: MediaInputAction,
): MediaInputState {
  switch (action.type) {
    case 'add':
      return {
        ...state,
        entries: [
          ...state.entries,
          ...action.acquired.map((item): UploadEntry => ({
            ...item,
            assetId: null,
            attempt: 0,
            error: null,
            inputDescriptor: null,
            previewUrl: action.previewUrls[item.clientId] ?? '',
            role: action.role ?? 'reference',
            status: 'queued',
          })),
        ],
      };
    case 'preprocessing':
    case 'uploading':
      return {
        ...state,
        entries: updateEntry(state.entries, action.clientId, (entry) => ({
          ...entry,
          error: null,
          status: action.type === 'preprocessing' ? 'preprocessing' : 'uploading',
        })),
      };
    case 'ready':
      return {
        ...state,
        entries: updateEntry(state.entries, action.clientId, (entry) => ({
          ...entry,
          assetId: action.assetId,
          error: null,
          inputDescriptor: action.inputDescriptor,
          status: 'ready',
        })),
      };
    case 'error':
      return {
        ...state,
        entries: updateEntry(state.entries, action.clientId, (entry) => ({
          ...entry,
          error: action.error,
          status: 'error',
        })),
      };
    case 'retry':
      return {
        ...state,
        entries: updateEntry(state.entries, action.clientId, (entry) => ({
          ...entry,
          assetId: null,
          attempt: entry.attempt + 1,
          error: null,
          inputDescriptor: null,
          status: 'queued',
        })),
        rejections: [],
      };
    case 'remove':
      return {
        ...state,
        entries: state.entries.filter((entry) => entry.clientId !== action.clientId),
        rejections: [],
      };
    case 'reject':
      return { ...state, rejections: action.rejections };
  }
}
