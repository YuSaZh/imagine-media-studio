import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { PR1_MOCK_GALLERY_ITEMS } from '../model/fixtures.js';
import { GalleryPagination, VirtualGallery } from './virtual-gallery.js';

function renderGallery(
  props: Partial<ComponentProps<typeof VirtualGallery>> = {},
): string {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(VirtualGallery, {
        emptyLabel: 'No media',
        items: PR1_MOCK_GALLERY_ITEMS,
        onFetchNextPage: vi.fn(),
        scrollElementRef: { current: null },
        ...props,
      }),
    ),
  );
}

describe('VirtualGallery pagination states', () => {
  it('keeps a fixed loading state before the first page arrives', () => {
    const markup = renderGallery({ items: [], isInitialLoading: true });

    expect(markup).toContain('data-gallery-state="loading"');
    expect(markup).toContain('Loading media...');
    expect(markup).toContain('data-gallery-sentinel="true"');
  });

  it('renders retry and terminal states without changing the gallery shell', () => {
    const retry = vi.fn();
    const errorMarkup = renderGallery({ isError: true, onRetry: retry });
    expect(errorMarkup).toContain('data-gallery-state="error"');
    expect(errorMarkup).toContain('Retry');

    const endMarkup = renderGallery({ hasNextPage: false, onFetchNextPage: vi.fn() });
    expect(endMarkup).toContain('data-gallery-state="end"');
    expect(endMarkup).toContain('End of gallery');
  });

  it('exposes the same state contract for the non-virtual Jobs list', () => {
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(GalleryPagination, {
          hasNextPage: false,
          isInitialLoading: true,
          onFetchNextPage: vi.fn(),
          scrollElementRef: { current: null },
        }),
      ),
    );

    expect(markup).toContain('data-gallery-state="loading"');
    expect(markup).toContain('data-gallery-sentinel="true"');
  });
});
