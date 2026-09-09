import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { internalClient } from '../../api/internal-client';
import { internalQueryKeys } from '../../api/query-keys';
import { ACTIVE_JOB_STATUSES } from './data';

export const seriesKey = (id: string) => [...internalQueryKeys.assets, 'editing-series', id] as const;
export async function fetchSeries(client: QueryClient, id: string) {
  const result = await internalClient.getAssetSeries(id);
  for (const asset of result.assets) {
    client.setQueryData(seriesKey(asset.id), result);
    client.setQueryData([...internalQueryKeys.assets, 'detail', asset.id], { asset });
  }
  for (const job of result.jobs) client.setQueryData([...internalQueryKeys.jobs, 'detail', job.id], {
    job, assets: result.assets.filter(asset => asset.jobId === job.id),
    inputs: job.request.inputs.map((input, sortOrder) => ({ ...input, sortOrder })),
  });
  return result;
}
export function useAssetSeries(id: string | null, online: boolean) {
  const client = useQueryClient();
  return useQuery({ queryKey: seriesKey(id ?? ''), queryFn: () => fetchSeries(client, id!), enabled: online && !!id, staleTime: 30000,
    refetchInterval: query => query.state.data?.jobs.some(job => ACTIVE_JOB_STATUSES.has(job.status)) ? 1500 : false });
}
