import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ImageInputPolicy } from '@imagine/shared';

import { uploadReferenceImage } from '../api/reference-upload.js';
import {
  compatibleSourceMimeTypes,
  prepareBrowserImage,
} from '../model/browser-image-preprocessor.js';
import {
  acquireImageFiles,
  type AcquisitionOptions,
} from '../model/acquisition.js';
import { PreviewUrlRegistry } from '../model/preview-url-registry.js';
import {
  initialMediaInputState,
  mediaInputReducer,
  type MediaInputAction,
} from '../model/upload-reducer.js';
import { UploadController } from '../model/upload-controller.js';
import type { AcquisitionRejection } from '../model/types.js';

export interface AddReferenceFilesOptions {
  existingCount: number;
  existingTotalBytes?: number;
  maxItems: number;
  preliminaryRejections?: readonly AcquisitionRejection[];
}

export interface ReferenceUploadCallbacks {
  fixtureMode: boolean;
  onReady: (clientId: string, assetId: string) => void;
  onRemoveReady: (assetId: string) => void;
  preprocessPolicy: ImageInputPolicy;
  preserveReadyOnDispose?: boolean;
}

export function useReferenceUploads(callbacks: ReferenceUploadCallbacks) {
  const [state, dispatch] = useReducer(mediaInputReducer, initialMediaInputState);
  const stateRef = useRef(state);
  const callbacksRef = useRef(callbacks);
  const previewsRef = useRef<PreviewUrlRegistry | null>(null);
  const controllerRef = useRef<UploadController | null>(null);
  const readyAssetsRef = useRef(new Map<string, string>());
  stateRef.current = state;
  callbacksRef.current = callbacks;
  previewsRef.current ??= new PreviewUrlRegistry();

  useEffect(() => {
    const transition = (action: MediaInputAction) => {
      if (action.type === 'ready') {
        readyAssetsRef.current.set(action.clientId, action.assetId);
        callbacksRef.current.onReady(action.clientId, action.assetId);
      }
      dispatch(action);
    };
    const controller = new UploadController({
      concurrency: 2,
      onTransition: transition,
      prepare: (file, signal) => prepareBrowserImage(file, signal, {
        policy: callbacksRef.current.preprocessPolicy,
      }),
      upload: (file, signal, inputDescriptor) =>
        uploadReferenceImage(
          file,
          signal,
          callbacksRef.current.fixtureMode,
          inputDescriptor,
        ),
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
      previewsRef.current?.dispose();
      if (callbacksRef.current.preserveReadyOnDispose === false) {
        for (const assetId of readyAssetsRef.current.values()) {
          callbacksRef.current.onRemoveReady(assetId);
        }
      }
      readyAssetsRef.current.clear();
    };
  }, []);

  const addFiles = useCallback((files: readonly File[], options: AddReferenceFilesOptions) => {
    const existingFingerprints = new Set(stateRef.current.entries.map((entry) => entry.fingerprint));
    const acquisitionOptions: AcquisitionOptions = {
      allowDuplicateFingerprints: callbacksRef.current.fixtureMode,
      allowedMimeTypes: compatibleSourceMimeTypes(callbacksRef.current.preprocessPolicy),
      existingCount: options.existingCount,
      existingFingerprints,
      existingTotalBytes:
        (options.existingTotalBytes ?? 0) +
        stateRef.current.entries.reduce(
          (sum, entry) => sum + (entry.inputDescriptor?.fileSize ?? entry.file.size),
          0,
        ),
      maxFileBytes: callbacksRef.current.preprocessPolicy.maxFileBytes,
      maxItems: options.maxItems,
      maxTotalBytes: callbacksRef.current.preprocessPolicy.maxTotalBytes,
    };
    const result = acquireImageFiles(files, acquisitionOptions);
    let previewUrls: Readonly<Record<string, string>>;
    try {
      previewUrls = previewsRef.current!.createBatch(result.accepted);
    } catch {
      dispatch({
        rejections: [
          ...(options.preliminaryRejections ?? []),
          ...result.rejected,
          ...result.accepted.map((input) => ({
            name: input.file.name || 'Pasted image',
            reason: 'preview_failed' as const,
          })),
        ],
        type: 'reject',
      });
      return;
    }
    const rejections = [...(options.preliminaryRejections ?? []), ...result.rejected];
    dispatch({ acquired: result.accepted, previewUrls, type: 'add' });
    dispatch({ rejections, type: 'reject' });
    controllerRef.current?.enqueue(result.accepted);
  }, []);

  const remove = useCallback((clientId: string) => {
    const entry = stateRef.current.entries.find((candidate) => candidate.clientId === clientId);
    if (entry?.assetId) callbacksRef.current.onRemoveReady(entry.assetId);
    readyAssetsRef.current.delete(clientId);
    previewsRef.current?.release(clientId);
    controllerRef.current?.remove(clientId);
  }, []);

  const retry = useCallback((clientId: string) => {
    dispatch({ rejections: [], type: 'reject' });
    controllerRef.current?.retry(clientId);
  }, []);

  const clearRejections = useCallback(() => {
    dispatch({ rejections: [], type: 'reject' });
  }, []);

  return { addFiles, clearRejections, remove, retry, state };
}
