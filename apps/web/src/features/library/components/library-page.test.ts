import { describe, expect, it } from 'vitest';

import { createMockSubmissionItems } from '../../gallery/api/gallery-query.js';
import { PR1_MOCK_GALLERY_ITEMS } from '../../gallery/model/fixtures.js';
import { groupGalleryItemsByJob } from './library-page.js';

describe('groupGalleryItemsByJob', () => {
  it('renders one task row for every batch job', () => {
    const batch = createMockSubmissionItems(
      {
        mode: 'image',
        prompt: 'One job with four outputs',
        modelId: 'studio-image-v1',
        count: 4,
        aspectRatio: '1:1',
        durationSeconds: null,
        referenceCount: 0,
      },
      91,
    );

    const grouped = groupGalleryItemsByJob([...batch, ...PR1_MOCK_GALLERY_ITEMS]);

    expect(grouped.filter((item) => item.jobId === batch[0]?.jobId)).toHaveLength(1);
    expect(grouped).toHaveLength(PR1_MOCK_GALLERY_ITEMS.length + 1);
  });
});
