import { renderToStaticMarkup } from 'react-dom/server';
import * as Tooltip from '@radix-ui/react-tooltip';
import { describe, expect, it } from 'vitest';

import { ReferenceStrip, type ReferenceStripItem } from './reference-strip.js';

describe('ReferenceStrip', () => {
  it('renders role, upload, incompatibility, error, retry, and remove states accessibly', () => {
    const items: readonly ReferenceStripItem[] = [
      {
        alt: 'Source image',
        error: null,
        id: 'source-1',
        incompatible: false,
        role: 'source',
        src: '/source.png',
        status: 'stored',
      },
      {
        alt: 'Uploading image',
        error: null,
        id: 'upload-1',
        incompatible: true,
        role: 'reference',
        src: 'blob:upload',
        status: 'uploading',
      },
      {
        alt: 'Failed image',
        error: 'Network unavailable',
        id: 'error-1',
        incompatible: false,
        role: 'reference',
        src: 'blob:error',
        status: 'error',
      },
      {
        alt: 'Unavailable input',
        error: null,
        id: 'missing-1',
        incompatible: true,
        role: 'reference',
        src: '/icons/app-icon-192.png',
        status: 'missing',
      },
      {
        alt: 'Pending inventory input',
        error: null,
        id: 'checking-1',
        incompatible: false,
        role: 'reference',
        src: '/icons/app-icon-192.png',
        status: 'checking',
      },
    ];
    const markup = renderToStaticMarkup(
      <Tooltip.Provider>
        <ReferenceStrip items={items} onRemove={() => undefined} onRetry={() => undefined} />
      </Tooltip.Provider>,
    );
    expect(markup).toContain('Source');
    expect(markup).toContain('Not supported by this model');
    expect(markup).toContain('Network unavailable');
    expect(markup).toContain('Input is no longer available');
    expect(markup).toContain('Checking input');
    expect(markup).toContain('aria-label="Retry Failed image"');
    expect(markup).toContain('aria-label="Remove Source image"');
  });
});
