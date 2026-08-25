import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from './app';
import { subscribeToAuthRequired } from './api/internal-client';
import { subscribeToInternalEvents } from './api/internal-events';
import { AuthGate } from './features/auth/components/auth-gate';
import { registerPwa } from './pwa-registration';
import { isVisualFixtureMode } from './visual-fixture';
import './styles/tokens.css';
import './styles.css';

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

function AuthenticatedApplication({ fixtureMode }: { fixtureMode: boolean }) {
  const [queryClient] = useState(createAppQueryClient);

  useEffect(() => {
    if (fixtureMode) return;
    const unsubscribe = subscribeToInternalEvents(queryClient);
    window.addEventListener('beforeunload', unsubscribe, { once: true });
    return () => {
      window.removeEventListener('beforeunload', unsubscribe);
      unsubscribe();
    };
  }, [fixtureMode, queryClient]);

  useEffect(() => {
    if (fixtureMode) return;
    return subscribeToAuthRequired(() => queryClient.clear());
  }, [fixtureMode, queryClient]);

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

const fixtureMode = isVisualFixtureMode();

createRoot(rootElement).render(
  <StrictMode>
    <AuthGate fixtureMode={fixtureMode}>
      <AuthenticatedApplication fixtureMode={fixtureMode} />
    </AuthGate>
  </StrictMode>,
);

registerPwa();
