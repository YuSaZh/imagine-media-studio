import type {
  FixtureAspectRatio,
  FixtureError,
  FixtureGalleryItem,
  FixtureImageItem,
  FixtureJobStatus,
  FixtureProvider,
  FixtureVideoItem,
  GalleryFixture,
} from './types.js';

interface MediaStudy {
  readonly path: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
  readonly aspectRatio: FixtureAspectRatio;
}

const FIXTURE_EPOCH_MS = Date.parse('2026-08-24T18:30:00.000Z');
const FIXTURE_INTERVAL_MS = 37 * 60 * 1000;

const FOLDER_IDS = ['folder-editorial', 'folder-places', 'folder-portraits'] as const;

const MEDIA_STUDIES = [
  {
    path: '/mock-media/study-01-portrait.png',
    alt: 'Abstract green landscape with pale circular forms',
    width: 832,
    height: 1248,
    aspectRatio: '2:3',
  },
  {
    path: '/mock-media/study-02-landscape.png',
    alt: 'Dark geometric grid with coral, mint, and sand planes',
    width: 1200,
    height: 800,
    aspectRatio: '3:2',
  },
  {
    path: '/mock-media/study-03-square.png',
    alt: 'Orange square composition with concentric dark rings',
    width: 1024,
    height: 1024,
    aspectRatio: '1:1',
  },
  {
    path: '/mock-media/study-04-portrait.png',
    alt: 'Framed geometric poster with coral, mint, and yellow forms',
    width: 832,
    height: 1248,
    aspectRatio: '2:3',
  },
  {
    path: '/mock-media/study-05-wide.png',
    alt: 'Blue wide composition with angular cream peaks and coral sun',
    width: 1536,
    height: 864,
    aspectRatio: '16:9',
  },
  {
    path: '/mock-media/study-06-portrait.png',
    alt: 'Dark portrait composition with pink, teal, and yellow geometry',
    width: 832,
    height: 1248,
    aspectRatio: '2:3',
  },
  {
    path: '/mock-media/study-07-square.png',
    alt: 'Soft green square study with rounded blocks and a diagonal line',
    width: 1024,
    height: 1024,
    aspectRatio: '1:1',
  },
  {
    path: '/mock-media/study-08-landscape.png',
    alt: 'Dark landscape composition with coral peaks and a mint moon',
    width: 1200,
    height: 800,
    aspectRatio: '3:2',
  },
  {
    path: '/mock-media/study-09-portrait.png',
    alt: 'Warm portrait composition with intersecting navy and yellow planes',
    width: 832,
    height: 1248,
    aspectRatio: '2:3',
  },
  {
    path: '/mock-media/study-10-wide.png',
    alt: 'Wide metallic study with rounded mint and orange forms',
    width: 1536,
    height: 864,
    aspectRatio: '16:9',
  },
  {
    path: '/mock-media/study-11-square.png',
    alt: 'High-contrast square collage with coral and teal geometry',
    width: 1024,
    height: 1024,
    aspectRatio: '1:1',
  },
  {
    path: '/mock-media/study-12-portrait.png',
    alt: 'Blue portrait composition with red circles and cream peaks',
    width: 832,
    height: 1248,
    aspectRatio: '2:3',
  },
  {
    path: '/mock-media/study-13-vertical.png',
    alt: 'Tall vertical study with layered geometric forms',
    width: 900,
    height: 1600,
    aspectRatio: '9:16',
  },
] as const satisfies readonly MediaStudy[];

const STATUS_BY_IMAGE_INDEX: ReadonlyMap<number, FixtureJobStatus> = new Map([
  [0, 'queued'],
  [3, 'submitting'],
  [6, 'remote_pending'],
  [9, 'remote_running'],
  [12, 'downloading'],
  [15, 'processing'],
  [18, 'failed'],
  [21, 'cancelled'],
  [24, 'rejected'],
  [27, 'expired'],
]);

const STATUS_STAGE = {
  queued: 'Waiting in queue',
  submitting: 'Submitting request',
  remote_pending: 'Waiting for provider',
  remote_running: 'Generating media',
  downloading: 'Downloading result',
  processing: 'Preparing media',
  completed: 'Ready',
  failed: 'Generation failed',
  cancelled: 'Cancelled',
  rejected: 'Request rejected',
  expired: 'Provider result expired',
} as const satisfies Readonly<Record<FixtureJobStatus, string>>;

const STATUS_PROGRESS = {
  queued: null,
  submitting: null,
  remote_pending: null,
  remote_running: 46,
  downloading: 78,
  processing: 91,
  completed: 100,
  failed: null,
  cancelled: null,
  rejected: null,
  expired: null,
} as const satisfies Readonly<Record<FixtureJobStatus, number | null>>;

export const PR1_MOCK_PROVIDER = {
  id: 'provider-studio-mock',
  type: 'mock',
  displayName: 'Studio Mock',
  enabled: true,
  isDefault: true,
  models: [
    {
      id: 'studio-image-v1',
      displayName: 'Studio Image',
      mediaKind: 'image',
      capabilities: {
        operations: ['image.generate', 'image.edit'],
        aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'],
        resolutions: ['1024', '1536'],
        durations: [],
        maxReferenceImages: 4,
        supportsMask: true,
        supportsProgress: true,
        supportsCancel: true,
        supportsBatchCount: true,
        maxBatchCount: 4,
      },
    },
    {
      id: 'studio-video-v1',
      displayName: 'Studio Motion',
      mediaKind: 'video',
      capabilities: {
        operations: ['video.generate', 'video.image_to_video', 'video.reference_to_video'],
        aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'],
        resolutions: ['720p', '1080p'],
        durations: [5, 10, 15],
        maxReferenceImages: 1,
        supportsMask: false,
        supportsProgress: true,
        supportsCancel: true,
        supportsBatchCount: false,
        maxBatchCount: 1,
      },
    },
  ],
} as const satisfies FixtureProvider;

function requiredAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`PR 1 fixture index ${index} is out of range.`);
  }
  return item;
}

function timestampFor(index: number): string {
  return new Date(FIXTURE_EPOCH_MS - index * FIXTURE_INTERVAL_MS).toISOString();
}

function foldersFor(index: number): readonly string[] {
  const folderIds: string[] = [];
  if (index % 3 === 0) folderIds.push(FOLDER_IDS[0]);
  if (index % 4 === 1) folderIds.push(FOLDER_IDS[1]);
  if (index % 5 === 2) folderIds.push(FOLDER_IDS[2]);
  return folderIds;
}

function errorFor(status: FixtureJobStatus): FixtureError | null {
  if (status === 'failed') {
    return {
      code: 'fixture_failed',
      message: 'The provider stopped before returning media.',
      retryable: true,
    };
  }
  if (status === 'rejected') {
    return {
      code: 'fixture_rejected',
      message: 'Revise the prompt before trying again.',
      retryable: false,
    };
  }
  if (status === 'expired') {
    return {
      code: 'fixture_expired',
      message: 'The remote result expired before it could be downloaded.',
      retryable: true,
    };
  }
  return null;
}

function itemStatus(index: number): FixtureJobStatus {
  return STATUS_BY_IMAGE_INDEX.get(index) ?? 'completed';
}

export const PR1_MOCK_IMAGE_ASSETS: readonly FixtureImageItem[] = Array.from(
  { length: 30 },
  (_, index): FixtureImageItem => {
    const sequence = index + 1;
    const study = requiredAt(MEDIA_STUDIES, index % MEDIA_STUDIES.length);
    const status = itemStatus(index);
    const suffix = String(sequence).padStart(2, '0');

    return {
      id: `image-${suffix}`,
      jobId: `job-image-${suffix}`,
      kind: 'image',
      prompt: `Editorial image study ${suffix}: composed light, material detail, and quiet atmosphere.`,
      alt: study.alt,
      createdAt: timestampFor(index),
      status,
      stage: STATUS_STAGE[status],
      progress: STATUS_PROGRESS[status],
      error: errorFor(status),
      saved: index % 4 === 0 || index === 7,
      folderIds: foldersFor(index),
      providerId: PR1_MOCK_PROVIDER.id,
      modelId: 'studio-image-v1',
      width: study.width,
      height: study.height,
      aspectRatio: study.aspectRatio,
      referenceCount: index % 7 === 0 ? 2 : 0,
      batchCount: index % 8 === 0 ? 4 : 1,
      previewPath: study.path,
      inputDescriptor: {
        fileSize: 1,
        height: study.height,
        mimeType: 'image/png',
        width: study.width,
      },
      persistedAsset: true,
      sourcePath: study.path,
      posterPath: null,
      durationSeconds: null,
    };
  },
);

export const PR1_MOCK_VIDEO_ITEMS: readonly FixtureVideoItem[] = Array.from(
  { length: 8 },
  (_, index): FixtureVideoItem => {
    const sequence = index + 1;
    const study = requiredAt(MEDIA_STUDIES, (index * 2 + 1) % MEDIA_STUDIES.length);
    const status = index < 6 ? 'completed' : index === 6 ? 'remote_running' : 'failed';
    const suffix = String(sequence).padStart(2, '0');

    return {
      id: `video-${suffix}`,
      jobId: `job-video-${suffix}`,
      kind: 'video',
      prompt: `Motion study ${suffix}: a restrained camera move through the composed scene.`,
      alt: `${study.alt}, video poster`,
      createdAt: timestampFor(30 + index),
      status,
      stage: STATUS_STAGE[status],
      progress: STATUS_PROGRESS[status],
      error: errorFor(status),
      saved: index % 3 === 0,
      folderIds: foldersFor(30 + index),
      providerId: PR1_MOCK_PROVIDER.id,
      modelId: 'studio-video-v1',
      width: study.width,
      height: study.height,
      aspectRatio: study.aspectRatio,
      referenceCount: index % 3 === 0 ? 1 : 0,
      batchCount: 1,
      previewPath: study.path,
      inputDescriptor: null,
      persistedAsset: true,
      sourcePath: '/mock-media/study-motion.mp4',
      posterPath: study.path,
      durationSeconds: [5, 10, 15][index % 3] ?? 5,
    };
  },
);

export const PR1_MOCK_GALLERY_ITEMS: readonly FixtureGalleryItem[] = [
  ...PR1_MOCK_IMAGE_ASSETS,
  ...PR1_MOCK_VIDEO_ITEMS,
].sort((left, right) => right.createdAt.localeCompare(left.createdAt));

export const PR1_MOCK_FOLDERS = [
  { id: FOLDER_IDS[0], name: 'Editorial Studies' },
  { id: FOLDER_IDS[1], name: 'Places and Spaces' },
  { id: FOLDER_IDS[2], name: 'Portrait Notes' },
].map((folder) => ({
  ...folder,
  itemIds: PR1_MOCK_GALLERY_ITEMS.filter((item) => item.folderIds.includes(folder.id)).map(
    (item) => item.id,
  ),
}));

export const PR1_GALLERY_FIXTURE: GalleryFixture = {
  version: 'pr1-v1',
  provider: PR1_MOCK_PROVIDER,
  imageAssets: PR1_MOCK_IMAGE_ASSETS,
  videoItems: PR1_MOCK_VIDEO_ITEMS,
  items: PR1_MOCK_GALLERY_ITEMS,
  folders: PR1_MOCK_FOLDERS,
};
