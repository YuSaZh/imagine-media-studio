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
import { ArrowUp, Image as ImageIcon, Plus, Settings2, Video, X } from 'lucide-react';

import { IconButton } from '../../../components/icon-button';
import { useUiStore } from '../../../stores/ui-store';
import { useGalleryQuery, useMockSubmission, useModelsQuery } from '../../gallery/api/gallery-query';
import type { FixtureAspectRatio } from '../../gallery/model/types';

interface ReferencePreview {
  id: string;
  name: string;
  src: string;
}

interface ComposerProps {
  isOnline: boolean;
}

export function Composer({ isOnline }: ComposerProps) {
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(1);
  const [aspectRatio, setAspectRatio] = useState<FixtureAspectRatio>('2:3');
  const [duration, setDuration] = useState(5);
  const [modelId, setModelId] = useState('studio-image-v1');
  const [references, setReferences] = useState<ReferencePreview[]>([]);
  const referencesRef = useRef<ReferencePreview[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLElement>(null);
  const composerMode = useUiStore((state) => state.composerMode);
  const composerExpanded = useUiStore((state) => state.composerExpanded);
  const paramsOpen = useUiStore((state) => state.composerParamsOpen);
  const composerReferenceAssetIds = useUiStore((state) => state.composerReferenceAssetIds);
  const limitComposerReferences = useUiStore((state) => state.limitComposerReferences);
  const removeComposerReference = useUiStore((state) => state.removeComposerReference);
  const setComposerMode = useUiStore((state) => state.setComposerMode);
  const setComposerExpanded = useUiStore((state) => state.setComposerExpanded);
  const setParamsOpen = useUiStore((state) => state.setComposerParamsOpen);
  const { data: galleryItems = [] } = useGalleryQuery();
  const { data: models = [] } = useModelsQuery();
  const submission = useMockSubmission();
  const selectedModel =
    models.find((model) => model.id === modelId && model.mediaKind === composerMode) ??
    models.find((model) => model.mediaKind === composerMode);
  const countOptions = Array.from(
    { length: selectedModel?.capabilities.maxBatchCount ?? 1 },
    (_, index) => index + 1,
  );
  const aspectOptions = selectedModel?.capabilities.aspectRatios ?? ['2:3'];
  const durationOptions = selectedModel?.capabilities.durations ?? [];
  const maxReferenceImages = selectedModel?.capabilities.maxReferenceImages ?? 0;
  const storedReferences = composerReferenceAssetIds
    .map((assetId) => galleryItems.find((item) => item.id === assetId))
    .filter((item) => item !== undefined)
    .slice(0, maxReferenceImages);
  const totalReferenceCount = Math.min(
    maxReferenceImages,
    storedReferences.length + references.length,
  );
  const canSubmit =
    isOnline && selectedModel !== undefined && prompt.trim().length > 0 && !submission.isPending;

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

  useEffect(() => {
    referencesRef.current = references;
  }, [references]);

  useEffect(() => () => {
    for (const reference of referencesRef.current) {
      if (reference.src.startsWith('blob:')) URL.revokeObjectURL(reference.src);
    }
  }, []);

  const addFiles = (files: readonly File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith('image/')).slice(0, 4);
    const available = Math.max(0, maxReferenceImages - storedReferences.length - references.length);
    const previews = imageFiles.slice(0, available).map((file, index) => ({
      id: `${globalThis.crypto.randomUUID()}-${index}`,
      name: file.name,
      src: URL.createObjectURL(file),
    }));
    if (previews.length > 0) setReferences((current) => [...current, ...previews].slice(0, 4));
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
    limitComposerReferences(maxReferenceImages);
    const localLimit = Math.max(0, maxReferenceImages - storedReferences.length);
    setReferences((current) => {
      if (current.length <= localLimit) return current;
      for (const reference of current.slice(localLimit)) {
        if (reference.src.startsWith('blob:')) URL.revokeObjectURL(reference.src);
      }
      return current.slice(0, localLimit);
    });
  }, [limitComposerReferences, maxReferenceImages, storedReferences.length]);

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
        count,
        aspectRatio,
        durationSeconds: composerMode === 'video' ? duration : null,
        referenceCount: totalReferenceCount,
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
    setDragActive(false);
    addFiles([...event.dataTransfer.files]);
  };

  return (
    <section
      aria-label="Generation composer"
      className={`composer ${composerExpanded ? 'is-expanded' : ''} ${dragActive ? 'is-dragging' : ''}`}
      onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
      onDragLeave={() => setDragActive(false)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
      ref={composerRef}
    >
      {dragActive && <div className="drop-overlay">Drop images to add references</div>}
      {storedReferences.length + references.length > 0 && (
        <div className="reference-strip" aria-label="Reference images">
          {storedReferences.map((reference) => (
            <div className="reference-preview" key={reference.id}>
              <img alt={reference.alt} src={reference.previewPath} />
              <IconButton
                icon={<X size={13} />}
                label={`Remove ${reference.alt}`}
                onClick={() => removeComposerReference(reference.id)}
              />
            </div>
          ))}
          {references.map((reference) => (
            <div className="reference-preview" key={reference.id}>
              <img alt={reference.name} src={reference.src} />
              <IconButton
                icon={<X size={13} />}
                label={`Remove ${reference.name}`}
                onClick={() => {
                  if (reference.src.startsWith('blob:')) URL.revokeObjectURL(reference.src);
                  setReferences((items) => items.filter((item) => item.id !== reference.id));
                }}
              />
            </div>
          ))}
        </div>
      )}
      <textarea
        aria-label="Prompt"
        onChange={(event) => setPrompt(event.target.value)}
        onFocus={() => setComposerExpanded(true)}
        onKeyDown={handleKeyDown}
        onPaste={(event) => {
          const files = [...event.clipboardData.items]
            .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);
          if (files.length > 0) addFiles(files);
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
          disabled={totalReferenceCount >= maxReferenceImages}
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
