import type { MediaRepairIssueInput, MediaRepairRecord, MediaRepairScanResult } from '../database/media-repair.js';
import { MEDIA_REPAIR_MAX_IDENTIFIER_LENGTH } from '../database/media-repair.js';
import type { MediaConsistencyReport } from './maintenance.js';

export const MAX_MEDIA_REPAIR_REPORT_ITEMS = 100;
const ASSET_ID_TOO_LONG_SENTINEL = '<asset-id-too-long>';

export interface MediaRepairAuditPort {
  audit(): Promise<MediaConsistencyReport>;
}

export interface MediaRepairQueuePort {
  count(): number | Promise<number>;
  list(options?: { readonly limit?: number }):
    | readonly MediaRepairRecord[]
    | Promise<readonly MediaRepairRecord[]>;
  upsertScan(
    issues: readonly MediaRepairIssueInput[],
    options?: { readonly truncated?: boolean },
  ): MediaRepairScanResult | Promise<MediaRepairScanResult>;
}

export interface MediaRepairReconcileResult {
  readonly scan: {
    readonly assetCount: number;
    readonly fileCount: number;
    readonly hashedBytes: number;
    readonly issueCount: number;
    readonly ok: boolean;
    readonly truncated: boolean;
  };
  readonly queue: MediaRepairScanResult;
}

export interface MediaRepairListResult {
  readonly count: number;
  readonly items: readonly MediaRepairRecord[];
  readonly truncated: boolean;
}

function safeAssetId(assetId: string | null): string | null {
  if (
    assetId === null ||
    assetId === ASSET_ID_TOO_LONG_SENTINEL ||
    assetId.length === 0 ||
    assetId.length > MEDIA_REPAIR_MAX_IDENTIFIER_LENGTH ||
    assetId.includes('\0') ||
    assetId.includes('\n') ||
    assetId.includes('\r')
  ) {
    return null;
  }
  return assetId;
}

export class MediaRepairCoordinator {
  private readonly auditPort: MediaRepairAuditPort;
  private readonly queue: MediaRepairQueuePort;

  public constructor(options: {
    readonly audit: MediaRepairAuditPort;
    readonly queue: MediaRepairQueuePort;
  }) {
    this.auditPort = options.audit;
    this.queue = options.queue;
  }

  public async reconcile(): Promise<MediaRepairReconcileResult> {
    const report = await this.auditPort.audit();
    const effectiveTruncated = report.truncated || report.issueCount !== report.issues.length;
    const issues: MediaRepairIssueInput[] = report.issues.map((issue) => ({
      assetId: safeAssetId(issue.assetId),
      jobId: null,
      kind: issue.kind,
      storedPath: issue.storedPath,
    }));
    const queue = await this.queue.upsertScan(issues, { truncated: effectiveTruncated });
    return {
      queue,
      scan: {
        assetCount: report.assetCount,
        fileCount: report.fileCount,
        hashedBytes: report.hashedBytes,
        issueCount: report.issueCount,
        ok: report.ok && !effectiveTruncated,
        truncated: effectiveTruncated,
      },
    };
  }

  public async listRepairs(): Promise<MediaRepairListResult> {
    const records = await this.queue.list({ limit: MAX_MEDIA_REPAIR_REPORT_ITEMS + 1 });
    const count = await this.queue.count();
    return {
      count,
      items: records.slice(0, MAX_MEDIA_REPAIR_REPORT_ITEMS),
      truncated: count > MAX_MEDIA_REPAIR_REPORT_ITEMS || records.length > MAX_MEDIA_REPAIR_REPORT_ITEMS,
    };
  }
}
