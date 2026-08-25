import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useQueryClient } from '@tanstack/react-query';
import { DEFAULT_IMAGE_INPUT_POLICY } from '@imagine/shared';
import { ArrowUp, Image as ImageIcon, Plus, Settings2, Video } from 'lucide-react';

import { IconButton } from '../../../components/icon-button';
import { internalQueryKeys } from '../../../api/query-keys';
import { useUiStore } from '../../../stores/ui-store';
import { isVisualFixtureMode } from '../../../visual-fixture';
import { ReferenceStrip, type ReferenceStripItem } from '../../media-input/components/reference-strip';
import { useReferenceUploads } from '../../media-input/hooks/use-reference-uploads';
import {
  filesFromClipboard,
  filesFromDataTransfer,
} from '../../media-input/model/acquisition';
import type { AcquisitionRejection } from '../../media-input/model/types';
import {
  hasExclusiveVideoInputConflict,
  descriptorsExceedingTotalBytes,
  storedInputAvailability,
  type StoredInputAvailability,
} from '../../media-input/model/input-compatibility';
import {
  useGalleryQuery,
  useGallerySubmission,
  useModelsQuery,
} from '../../gallery/api/gallery-query';
import type { FixtureAspectRatio } from '../../gallery/model/types';

interface ComposerProps {
  isOnline: boolean;
}

export function Composer({ isOnline }: ComposerProps) {
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(1);
  const [aspectRatio, setAspectRatio] = useState<FixtureAspectRatio>('2:3');
  const [duration, setDuration] = useState(5);
  const [modelId, setModelId] = useState('studio-image-v1');
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLElement>(null);
  const composerMode = useUiStore((state) => state.composerMode);
  const composerExpanded = useUiStore((state) => state.composerExpanded);
  const paramsOpen = useUiStore((state) => state.composerParamsOpen);
  const composerInputs = useUiStore((state) => state.composerInputs);
  const addComposerInput = useUiStore((state) => state.addComposerInput);
  const removeComposerInput = useUiStore((state) => state.removeComposerInput);
  const setComposerMode = useUiStore((state) => state.setComposerMode);
  const setComposerExpanded = useUiStore((state) => state.setComposerExpanded);
  const setParamsOpen = useUiStore((state) => state.setComposerParamsOpen);
  const galleryQuery = useGalleryQuery();
  const galleryItems = galleryQuery.data ?? [];
  const { data: models = [] } = useModelsQuery();
  const queryClient = useQueryClient();
  const visualFixtures = isVisualFixtureMode();
  const submission = useGallerySubmission();
  const selectedModel =
    models.find((model) => model.id === modelId && model.mediaKind === composerMode) ??
    models.find((model) => model.mediaKind === composerMode);
  const selectedInputPolicy =
    selectedModel?.capabilities.inputImagePolicy ?? DEFAULT_IMAGE_INPUT_POLICY;
  const uploads = useReferenceUploads({
    fixtureMode: visualFixtures,
    onReady: (_clientId, assetId) => {
      addComposerInput({ assetId, role: 'reference' });
      if (!visualFixtures) {
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: internalQueryKeys.assets }),
          queryClient.invalidateQueries({ queryKey: internalQueryKeys.gallery }),
        ]);
      }
    },
    onRemoveReady: (assetId) => removeComposerInput({ assetId, role: 'reference' }),
    preprocessPolicy: selectedInputPolicy,
    preserveReadyOnDispose: !visualFixtures,
  });
  const countOptions = Array.from(
    { length: selectedModel?.capabilities.maxBatchCount ?? 1 },
    (_, index) => index + 1,
  );
  const aspectOptions = selectedModel?.capabilities.aspectRatios ?? ['2:3'];
  const durationOptions = selectedModel?.capabilities.durations ?? [];
  const maxReferenceImages = selectedModel?.capabilities.maxReferenceImages ?? 0;
  const readyLocalAssetIds = new Set(
    uploads.state.entries.flatMap((entry) => entry.assetId === null ? [] : [entry.assetId]),
  );
  const referenceOrder = [
    ...composerInputs
      .filter((input) => input.role === 'reference')
      .map((input) => `asset:${input.assetId}`),
    ...uploads.state.entries
      .filter((entry) => entry.assetId === null)
      .map((entry) => `client:${entry.clientId}`),
  ];
  const incompatibleReferenceKeys = new Set(referenceOrder.slice(maxReferenceImages));
  const hasSource = composerInputs.some((input) => input.role === 'source');
  const hasVideoInputConflict = hasExclusiveVideoInputConflict(
    composerMode,
    composerInputs,
    uploads.state.entries.filter((entry) => entry.assetId === null).length,
  );
  const operationSupportsReferences = composerMode === 'image'
    ? selectedModel?.capabilities.operations.includes(hasSource ? 'image.edit' : 'image.generate') === true
    : selectedModel?.capabilities.operations.includes('video.reference_to_video') === true;
  const inputRoleIsIncompatible = (assetId: string, role: typeof composerInputs[number]['role']) => {
    if (role === 'reference') {
      return hasVideoInputConflict ||
        !operationSupportsReferences ||
        incompatibleReferenceKeys.has(`asset:${assetId}`);
    }
    if (role === 'source') {
      return composerMode !== 'image' || selectedModel?.capabilities.operations.includes('image.edit') !== true;
    }
    if (role === 'first_frame') {
      return hasVideoInputConflict ||
        composerMode !== 'video' ||
        selectedModel?.capabilities.operations.includes('video.image_to_video') !== true;
    }
    if (role === 'mask') return !selectedModel?.capabilities.supportsMask || !hasSource;
    return true;
  };
  const readyUploadByAssetId = new Map(
    uploads.state.entries.flatMap((entry) =>
      entry.assetId === null ? [] : [[entry.assetId, entry] as const]),
  );
  const galleryItemById = new Map(galleryItems.map((item) => [item.id, item]));
  const initialStoredInputChecks = composerInputs.map((input) => {
    const localEntry = readyUploadByAssetId.get(input.assetId);
    const galleryItem = galleryItemById.get(input.assetId);
    const candidate = localEntry
      ? { inputDescriptor: localEntry.inputDescriptor, persistedAsset: true }
      : galleryItem;
    const inventoryAvailability = storedInputAvailability(
      candidate,
      selectedInputPolicy,
      !galleryQuery.isPending,
    );
    return {
      availability: inventoryAvailability === 'ready' &&
        inputRoleIsIncompatible(input.assetId, input.role)
        ? 'incompatible' as const
        : inventoryAvailability,
      galleryItem,
      input,
      inputDescriptor: candidate?.inputDescriptor ?? null,
    };
  });
  const aggregateByteViolations = descriptorsExceedingTotalBytes(
    initialStoredInputChecks.map((check) => check.inputDescriptor),
    selectedInputPolicy,
  );
  const storedInputChecks = initialStoredInputChecks.map((check, index) => ({
    ...check,
    availability: check.availability === 'ready' && aggregateByteViolations.has(index)
      ? 'incompatible' as const
      : check.availability,
  }));
  const storedInputCheckByAssetId = new Map(
    storedInputChecks.map((check) => [check.input.assetId, check]),
  );
  const invalidStoredInputs = storedInputChecks.filter(
    (check) => check.availability !== 'ready',
  );
  const incompatibleLocalEntries = uploads.state.entries.filter((entry) =>
    entry.assetId === null && (
      incompatibleReferenceKeys.has(`client:${entry.clientId}`) ||
      !operationSupportsReferences ||
      hasVideoInputConflict
    ),
  );
  const unresolvedUploads = uploads.state.entries.filter((entry) => entry.status !== 'ready');
  const totalReferenceCount = composerInputs.filter((input) => input.role === 'reference').length;
  const canSubmit =
    isOnline &&
    selectedModel !== undefined &&
    prompt.trim().length > 0 &&
    unresolvedUploads.length === 0 &&
    invalidStoredInputs.length === 0 &&
    incompatibleLocalEntries.length === 0 &&
    !submission.isPending;

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const updateOffset = () => {
      const offset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      document.documentElement.style.setProperty('--keyboard-offset', `${offset}px`);
    };
    updateOffset();
    viewport.addEventListener('resize', updateOffset);
    viewport.addEventListener('scroll', updateOffset);
    return () => {
      viewport.removeEventListener('resize', updateOffset);
      viewport.removeEventListener('scroll', updateOffset);
      document.documentElement.style.removeProperty('--keyboard-offset');
    };
  }, []);

  useEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    const updateHeight = () => {
      document.documentElement.style.setProperty(
        '--composer-height',
        `${element.getBoundingClientRect().height}px`,
      );
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--composer-height');
    };
  }, []);

  const addFiles = (
    files: readonly File[],
    preliminaryRejections: readonly AcquisitionRejection[] = [],
  ) => {
    uploads.addFiles(files, {
      existingCount: referenceOrder.length,
      existingTotalBytes: initialStoredInputChecks.reduce(
        (total, check) => readyLocalAssetIds.has(check.input.assetId)
          ? total
          : total + (check.inputDescriptor?.fileSize ?? 0),
        0,
      ),
      maxItems: operationSupportsReferences && !hasVideoInputConflict
        ? maxReferenceImages
        : 0,
      preliminaryRejections,
    });
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles([...event.target.files ?? []]);
    event.target.value = '';
  };

  const selectModel = useCallback((nextModelId: string) => {
    const nextModel = models.find((model) => model.id === nextModelId);
    if (!nextModel) return;
    const supportedDurations: readonly number[] = nextModel.capabilities.durations;
    setModelId(nextModel.id);
    setCount((current) => Math.min(current, nextModel.capabilities.maxBatchCount));
    setAspectRatio((current) =>
      nextModel.capabilities.aspectRatios.includes(current)
        ? current
        : (nextModel.capabilities.aspectRatios[0] ?? '2:3'),
    );
    setDuration((current) =>
      supportedDurations.includes(current)
        ? current
        : (supportedDurations[0] ?? 5),
    );
  }, [models]);

  useEffect(() => {
    const modeModel = models.find((model) => model.mediaKind === composerMode);
    if (modeModel && modeModel.id !== modelId) selectModel(modeModel.id);
  }, [composerMode, modelId, models, selectModel]);

  useEffect(() => {
    uploads.clearRejections();
  }, [selectedModel?.id, uploads.clearRejections]);

  const switchMode = (mode: 'image' | 'video') => {
    setComposerMode(mode);
    const nextModel = models.find((model) => model.mediaKind === mode);
    if (nextModel) selectModel(nextModel.id);
    if (mode === 'video') setCount(1);
  };

  const submit = () => {
    if (!canSubmit || !selectedModel) return;
    submission.mutate(
      {
        mode: composerMode,
        prompt: prompt.trim(),
        modelId: selectedModel.id,
        providerId: selectedModel.providerId,
        count,
        aspectRatio,
        durationSeconds: composerMode === 'video' ? duration : null,
        referenceCount: totalReferenceCount,
        inputAssets: composerInputs,
      },
      {
        onSuccess: () => {
          setPrompt('');
          setComposerExpanded(false);
        },
      },
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
    if (event.key === 'Escape') {
      setParamsOpen(false);
      setComposerExpanded(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    const transfer = filesFromDataTransfer(event.dataTransfer);
    addFiles(transfer.files, transfer.rejected);
  };

  const storedStripItems = storedInputChecks.flatMap((check): ReferenceStripItem[] => {
    const { input } = check;
    if (readyLocalAssetIds.has(input.assetId)) return [];
    const item = check.galleryItem;
    const missingStatus: Extract<StoredInputAvailability, 'checking' | 'missing'> | null =
      check.availability === 'checking' || check.availability === 'missing'
        ? check.availability
        : null;
    return [{
      alt: item?.alt ?? 'Unavailable input',
      error: null,
      id: `stored:${input.role}:${input.assetId}`,
      incompatible: check.availability === 'incompatible' || check.availability === 'missing',
      role: input.role,
      src: item?.previewPath ?? '/icons/app-icon-192.png',
      status: missingStatus ?? 'stored',
    }];
  });
  const localStripItems = uploads.state.entries.map((entry): ReferenceStripItem => {
    const storedCheck = entry.assetId === null
      ? undefined
      : storedInputCheckByAssetId.get(entry.assetId);
    return {
      alt: entry.file.name || 'Pasted image',
      error: entry.error,
      id: `upload:${entry.clientId}`,
      incompatible: storedCheck
        ? storedCheck.availability !== 'ready'
        : hasVideoInputConflict ||
          !operationSupportsReferences ||
          incompatibleReferenceKeys.has(`client:${entry.clientId}`),
      role: 'reference',
      src: entry.previewUrl,
      status: entry.status,
    };
  });
  const stripItems = [...storedStripItems, ...localStripItems];
  const removeStripItem = (id: string) => {
    const local = uploads.state.entries.find((entry) => `upload:${entry.clientId}` === id);
    if (local) {
      uploads.remove(local.clientId);
      return;
    }
    const stored = composerInputs.find(
      (input) => `stored:${input.role}:${input.assetId}` === id,
    );
    if (stored) {
      uploads.clearRejections();
      removeComposerInput(stored);
    }
  };
  const retryStripItem = (id: string) => {
    const local = uploads.state.entries.find((entry) => `upload:${entry.clientId}` === id);
    if (local) uploads.retry(local.clientId);
  };
  const rejectionMessage = uploads.state.rejections.length === 0
    ? null
    : uploads.state.rejections
        .map((item) => {
          const reason = {
            directory: 'folders are not supported',
            duplicate: 'duplicate image',
            empty: 'empty file',
            file_too_large: 'file is too large',
            item_limit: 'model reference limit reached',
            normalized_type_unsupported: 'selected model cannot accept the normalized image type',
            preview_failed: 'preview could not be created',
            total_too_large: 'combined files are too large',
            unsupported_type: 'unsupported image type',
          }[item.reason];
          return `${item.name}: ${reason}`;
        })
        .join(' · ');
  const submissionError = submission.error instanceof Error ? submission.error.message : null;

  return (
    <section
      aria-label="Generation composer"
      className={`composer ${composerExpanded ? 'is-expanded' : ''} ${dragActive ? 'is-dragging' : ''}`}
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepthRef.current += 1;
        setDragActive(true);
      }}
      onDragLeave={() => {
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragActive(false);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
      ref={composerRef}
    >
      {dragActive && <div className="drop-overlay">Drop images to add references</div>}
      <ReferenceStrip items={stripItems} onRemove={removeStripItem} onRetry={retryStripItem} />
      {(rejectionMessage || submissionError || unresolvedUploads.length > 0 || invalidStoredInputs.length > 0 || incompatibleLocalEntries.length > 0) && (
        <p className="composer-input-status" role={rejectionMessage || submissionError ? 'alert' : 'status'}>
          {rejectionMessage ?? submissionError ??
            (unresolvedUploads.some((entry) => entry.status === 'error')
              ? 'Remove or retry failed reference uploads before submitting.'
              : unresolvedUploads.length > 0
                ? 'Reference images are being prepared and uploaded.'
                : invalidStoredInputs.some((check) => check.availability === 'checking')
                  ? 'Checking saved image inputs.'
                  : invalidStoredInputs.some((check) => check.availability === 'missing')
                    ? 'Remove image inputs that are no longer available.'
                    : 'Remove inputs that are not supported by the selected model.')}
        </p>
      )}
      <textarea
        aria-label="Prompt"
        onChange={(event) => setPrompt(event.target.value)}
        onFocus={() => setComposerExpanded(true)}
        onKeyDown={handleKeyDown}
        onPaste={(event) => {
          const transfer = filesFromClipboard(event.clipboardData);
          if (transfer.files.length > 0) {
            if (!transfer.hasText) event.preventDefault();
            addFiles(transfer.files, transfer.rejected);
          }
        }}
        placeholder={composerMode === 'image' ? 'Imagine anything' : 'Describe a scene in motion'}
        rows={composerExpanded ? 2 : 1}
        value={prompt}
      />
      <div className="composer-toolbar">
        <input
          accept="image/*"
          aria-label="Reference image files"
          className="sr-only"
          multiple
          onChange={handleFileChange}
          ref={fileInputRef}
          tabIndex={-1}
          type="file"
        />
        <IconButton
          disabled={
            referenceOrder.length >= maxReferenceImages ||
            !operationSupportsReferences ||
            hasVideoInputConflict
          }
          icon={<Plus size={20} />}
          label="Add reference image"
          onClick={() => fileInputRef.current?.click()}
        />
        <div className="segmented-control" aria-label="Generation mode" role="group">
          <button
            aria-pressed={composerMode === 'image'}
            onClick={() => switchMode('image')}
            type="button"
          >
            <ImageIcon size={15} />Image
          </button>
          <button
            aria-pressed={composerMode === 'video'}
            onClick={() => switchMode('video')}
            type="button"
          >
            <Video size={15} />Video
          </button>
        </div>
        <select
          aria-label="Result count"
          className="composer-select"
          disabled={composerMode === 'video'}
          onChange={(event) => setCount(Number(event.target.value))}
          value={count}
        >
          {countOptions.map((option) => <option key={option} value={option}>x{option}</option>)}
        </select>
        <select
          aria-label="Aspect ratio"
          className="composer-select"
          onChange={(event) => setAspectRatio(event.target.value as FixtureAspectRatio)}
          value={aspectRatio}
        >
          {aspectOptions.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        <Popover.Root open={paramsOpen} onOpenChange={setParamsOpen}>
          <Popover.Trigger asChild>
            <IconButton icon={<Settings2 size={17} />} label="Generation parameters" />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content align="end" className="parameters-popover" sideOffset={10}>
              <div className="popover-heading">
                <strong>Parameters</strong>
                <span>{selectedModel?.displayName ?? 'No model'}</span>
              </div>
              <label>
                <span>Model</span>
                <select
                  aria-label="Model"
                  onChange={(event) => selectModel(event.target.value)}
                  value={selectedModel?.id ?? ''}
                >
                  {models
                    .filter((model) => model.mediaKind === composerMode)
                    .map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
                </select>
              </label>
              <label className="parameter-mobile-only">
                <span>Count</span>
                <select
                  aria-label="Mobile result count"
                  disabled={composerMode === 'video'}
                  onChange={(event) => setCount(Number(event.target.value))}
                  value={count}
                >
                  {countOptions.map((option) => <option key={option} value={option}>x{option}</option>)}
                </select>
              </label>
              <label className="parameter-mobile-only">
                <span>Aspect</span>
                <select
                  aria-label="Mobile aspect ratio"
                  onChange={(event) => setAspectRatio(event.target.value as FixtureAspectRatio)}
                  value={aspectRatio}
                >
                  {aspectOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </label>
              {composerMode === 'video' && (
                <label>
                  <span>Duration</span>
                  <select onChange={(event) => setDuration(Number(event.target.value))} value={duration}>
                    {durationOptions.map((option) => (
                      <option key={option} value={option}>{option} seconds</option>
                    ))}
                  </select>
                </label>
              )}
              <Popover.Arrow className="popover-arrow" />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <IconButton
          className="composer-submit"
          disabled={!canSubmit}
          icon={<ArrowUp size={19} strokeWidth={2.5} />}
          label={isOnline ? 'Generate' : 'Unavailable offline'}
          onClick={submit}
          tone="primary"
        />
      </div>
    </section>
  );
}
