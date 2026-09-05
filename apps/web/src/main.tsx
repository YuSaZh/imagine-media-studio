import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from './app';
import { subscribeToAuthRequired } from './api/internal-client';
import { subscribeToInternalEvents } from './api/internal-events';
import { AuthGate } from './features/auth/components/auth-gate';
import { flushPromptDraft } from './features/composer/model/composer-draft';
import { registerPwa } from './pwa-registration';
import './features/workspace/workspace.css';

function createAppQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: true,
        retry: 2,
        staleTime: 30_000,
      },
    },
  });
}

function AuthenticatedApplication() {
  const [queryClient] = useState(createAppQueryClient);

  useEffect(() => {
    const unsubscribe = subscribeToInternalEvents(queryClient);
    window.addEventListener('beforeunload', unsubscribe, { once: true });
    return () => {
      window.removeEventListener('beforeunload', unsubscribe);
      unsubscribe();
    };
  }, [queryClient]);

  useEffect(() => {
    return subscribeToAuthRequired(() => queryClient.clear());
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider delayDuration={450} skipDelayDuration={120}>
        <App />
      </Tooltip.Provider>
    </QueryClientProvider>
  );
}

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Application root element was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <AuthGate>
      <AuthenticatedApplication />
    </AuthGate>
  </StrictMode>,
);

registerPwa({ draftFlushHook: flushPromptDraft });
