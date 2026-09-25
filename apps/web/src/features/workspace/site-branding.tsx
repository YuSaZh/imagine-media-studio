import { createContext, useContext, useEffect, useCallback, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { internalClient } from '../../api/internal-client';

const defaults = { name: 'Imagine.', logoUrl: '/icons/app-icon-192.png' };
const BrandingContext = createContext({ ...defaults, refresh: () => {} });
export const useSiteBranding = () => useContext(BrandingContext);
export function SiteBranding({ children }: { children: ReactNode }) {
  const query = useQuery({ queryKey: ['public', 'branding'], queryFn: () => internalClient.getSiteBranding(), staleTime: 30000 });
  const branding = query.data ?? defaults;
  const refresh = useCallback(() => { void query.refetch(); }, [query.refetch]);
  useEffect(() => {
    document.title = branding.name;
    document.querySelector('link[rel="icon"]')?.setAttribute('href', branding.logoUrl);
    document.querySelector('link[rel="apple-touch-icon"]')?.setAttribute('href', branding.logoUrl);
    document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', branding.name);
  }, [branding]);
  return <BrandingContext.Provider value={{ ...branding, refresh }}>{children}</BrandingContext.Provider>;
}
