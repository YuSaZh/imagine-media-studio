import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const registerSwMock = vi.hoisted(() => vi.fn());

vi.mock('virtual:pwa-register', () => ({ registerSW: registerSwMock }));

import { activatePwaUpdate, getPwaState, registerPwa } from '../../../pwa-registration.js';
import { internalQueryKeys } from '../../../api/query-keys.js';
import { GENERAL_SETTING_DEFAULTS } from '../api/settings-query.js';
import { PwaSettings } from './settings-page.js';

afterEach(() => {
  registerSwMock.mockReset();
});

describe('PwaSettings', () => {
  it('keeps a pending update actionable when notifications are disabled', async () => {
    let onNeedRefresh: (() => void) | undefined;
    const update = vi.fn<((reloadPage?: boolean) => Promise<void>)>().mockResolvedValue(undefined);
    registerSwMock.mockImplementation((options: { onNeedRefresh?: () => void }) => {
      onNeedRefresh = options.onNeedRefresh;
      return update;
    });
    registerPwa();
    onNeedRefresh?.();

    const queryClient = new QueryClient();
    queryClient.setQueryData([...internalQueryKeys.settings, 'fixture'], {
      settings: { ...GENERAL_SETTING_DEFAULTS, 'pwa.update_notifications': false },
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <PwaSettings fixtureMode isOnline isStandalone={false} />
      </QueryClientProvider>,
    );

    expect(html).toContain('Application update');
    expect(html).toContain('Available');
    expect(html).toContain('Apply update');

    await activatePwaUpdate();
    expect(update).toHaveBeenCalledWith(true);
    expect(getPwaState()).toMatchObject({ updateAvailable: false, updating: false });
  });
});
