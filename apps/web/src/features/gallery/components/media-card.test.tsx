import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { describe, expect, it } from 'vitest';

import { PR1_MOCK_FOLDERS, PR1_MOCK_IMAGE_ASSETS } from '../model/fixtures.js';
import { MediaCard } from './media-card.js';

function renderCard(item = PR1_MOCK_IMAGE_ASSETS[0]!) {
  return renderToStaticMarkup(
    createElement(
      Tooltip.Provider,
      null,
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(MediaCard, { folders: PR1_MOCK_FOLDERS, item }),
      ),
    ),
  );
}

describe('MediaCard selection and task accessibility', () => {
  it('describes queued task state and exposes non-gesture selection controls', () => {
    const markup = renderCard();

    expect(markup).toContain('aria-label="Select Abstract green landscape with pale circular forms"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('Task status: queued. Stage: Waiting in queue. Progress: unavailable. Error: none.');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-describedby="media-card-status-image-01"');
    expect(markup).toContain('Select Abstract green landscape with pale circular forms');
  });

  it('keeps one direct Select tab stop while retaining the Card actions menu entry', () => {
    const markup = renderCard();
    const directSelectLabels = markup.match(
      /aria-label="Select Abstract green landscape with pale circular forms"/gu,
    ) ?? [];

    expect(directSelectLabels).toHaveLength(1);
    expect(markup).toContain('aria-label="Card actions"');
    expect(markup).toContain('class="selection-toggle"');
  });

  it('includes progress, stage, and provider error details in the live description', () => {
    const item = PR1_MOCK_IMAGE_ASSETS.find((candidate) => candidate.status === 'failed');
    if (!item) throw new Error('The fixture must include a failed image item.');

    const markup = renderCard(item);
    expect(markup).toContain('Task status: failed.');
    expect(markup).toContain(`Stage: ${item.stage}.`);
    expect(markup).toContain(`Error: ${item.error?.message} Retry available.`);
  });

});
