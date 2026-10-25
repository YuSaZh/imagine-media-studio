import type { AssetDto } from '@imagine/shared';
import { InternalApiError, internalClient } from '../../api/internal-client';
import { t } from '../../i18n';
import { ACTIVE_JOB_STATUSES, RETRYABLE_JOB_STATUSES } from './job-status';

export interface SeriesDeletionPlan {
  assets: AssetDto[];
  jobIds: string[];
}

/** Freeze the confirmed members before deleting the cover used to find them. */
export function createSeriesDeletionPlan(series: Awaited<ReturnType<typeof internalClient.getAssetSeries>>): SeriesDeletionPlan {
  if (series.truncated) throw new Error(t("系列过大，无法完整删除"));
  if (series.jobs.some(job => ACTIVE_JOB_STATUSES.has(job.status))) throw new Error(t("请先取消系列中正在运行的任务"));
  return {
    assets: [...new Map(series.assets.map(asset => [asset.id, asset])).values()],
    jobIds: [...new Set(series.jobs.filter(job => RETRYABLE_JOB_STATUSES.has(job.status)).map(job => job.id))],
  };
}

function removed(result: PromiseSettledResult<void>, missingCode: string): boolean {
  return result.status === 'fulfilled' || result.reason instanceof InternalApiError
    && result.reason.status === 404 && result.reason.code === missingCode;
}

/** Retain only unresolved IDs, including ambiguous requests whose response was lost. */
export async function runSeriesDeletion(plan: SeriesDeletionPlan, client: Pick<typeof internalClient, 'deleteAsset' | 'deleteJob'> = internalClient) {
  const assets = plan.assets;
  const assetResults = await Promise.allSettled(assets.map(async asset => client.deleteAsset(asset.id)));
  const deletedAssets = assets.filter((_asset, index) => removed(assetResults[index]!, 'asset_not_found'));
  plan.assets = assets.filter((_asset, index) => !removed(assetResults[index]!, 'asset_not_found'));
  const deletedJobIds: string[] = [];
  // Preserve task records until all confirmed assets have been removed.
  if (!plan.assets.length) {
    const ids = plan.jobIds;
    const results = await Promise.allSettled(ids.map(async id => client.deleteJob(id)));
    plan.jobIds = ids.filter((id, index) => {
      if (!removed(results[index]!, 'job_not_found')) return true;
      deletedJobIds.push(id);
      return false;
    });
  }
  return { deletedAssets, deletedJobIds, complete: !plan.assets.length && !plan.jobIds.length };
}
