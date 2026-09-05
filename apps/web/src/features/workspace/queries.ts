import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { internalClient } from '../../api/internal-client';
import { internalQueryKeys as keys } from '../../api/query-keys';
import { allPages, fetchMediaPage, type MediaFilter } from './data';

export function useMedia(filter: MediaFilter) {
  return useInfiniteQuery({
    queryKey: [...keys.assets, 'workspace', filter],
    queryFn: ({ pageParam }) => fetchMediaPage(filter, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    retry: false,
  });
}

export function useWorkspaceJobs(status?: string) {
  return useInfiniteQuery({
    queryKey: [...keys.jobs, 'workspace', status ?? 'all'],
    queryFn: ({ pageParam }) => internalClient.listJobs({ limit: 60, ...(pageParam ? { cursor: pageParam } : {}), ...(status ? { status } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    refetchInterval: query => query.state.data?.pages[0]?.items.some(job => !['completed', 'failed', 'cancelled', 'rejected', 'expired'].includes(job.status)) ? 10000 : false,
  });
}

export function useWorkspaceCatalog() {
  const providers = useQuery({ queryKey: [...keys.providers, 'workspace'], queryFn: () => allPages(cursor => internalClient.listProviders({ limit: 100, ...(cursor ? { cursor } : {}) })) });
  const models = useQuery({ queryKey: [...keys.models, 'workspace'], queryFn: () => allPages(cursor => internalClient.listModels({ limit: 100, ...(cursor ? { cursor } : {}) })) });
  const projects = useQuery({ queryKey: [...keys.collections, 'workspace'], queryFn: () => allPages(cursor => internalClient.listCollections({ limit: 100, ...(cursor ? { cursor } : {}) })) });
  return { providers, models, projects };
}

export function useRefreshWorkspace() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: keys.all });
}
