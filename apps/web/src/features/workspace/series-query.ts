import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { internalClient } from '../../api/internal-client';
import { internalQueryKeys } from '../../api/query-keys';
import { ACTIVE_JOB_STATUSES } from './data';
import { readGeneralSettings, useSettingsQuery } from '../settings/api/settings-query';

export const seriesKey = (id: string, groupConcurrentImages = false) => [...internalQueryKeys.assets, 'editing-series', id, groupConcurrentImages] as const;
export async function fetchSeries(client: QueryClient, id: string, groupConcurrentImages = false) {
  const result = await internalClient.getAssetSeries(id, groupConcurrentImages);
  for (const asset of result.assets) {
    client.setQueryData(seriesKey(asset.id, groupConcurrentImages), result);
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
  const settings = useSettingsQuery();
  const preferences = readGeneralSettings(settings.data?.settings);
  const grouped = preferences.groupBySeries && preferences.groupConcurrentImages;
  return useQuery({ queryKey: seriesKey(id ?? '', grouped), queryFn: () => fetchSeries(client, id!, grouped), enabled: online && !!id, staleTime: 30000,
    refetchInterval: query => query.state.data?.jobs.some(job => ACTIVE_JOB_STATUSES.has(job.status)) ? 1500 : false });
}
