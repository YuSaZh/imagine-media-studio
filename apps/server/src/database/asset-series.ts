import { sql } from 'drizzle-orm';
import type { AppDatabase } from './client.js';

export interface SeriesNode { node: string; parent: string | null; }

/** One primary parent per node; roots are memoized iteratively, including cycles. */
export class AssetSeriesGraph {
  public readonly roots = new Map<string, string>();
  private readonly edges = new Map<string, string[]>();

  public constructor(nodes: readonly SeriesNode[], links: readonly { node: string; linked: string }[] = []) {
    const parents = new Map(nodes.map(row => [row.node, row.parent]));
    for (const { node, parent } of nodes) {
      if (!this.edges.has(node)) this.edges.set(node, []);
      if (parent && parents.has(parent)) {
        this.edges.get(node)!.push(parent);
        const siblings = this.edges.get(parent) ?? [];
        siblings.push(node); this.edges.set(parent, siblings);
      }
    }
    for (const { node } of nodes) {
      if (this.roots.has(node)) continue;
      const path: string[] = [], positions = new Map<string, number>();
      let cursor = node, root: string;
      for (;;) {
        const known = this.roots.get(cursor);
        if (known !== undefined) { root = known; break; }
        const cycleStart = positions.get(cursor);
        if (cycleStart !== undefined) {
          root = path.slice(cycleStart).reduce((smallest, item) => item < smallest ? item : smallest);
          break;
        }
        positions.set(cursor, path.length); path.push(cursor);
        const parent = parents.get(cursor);
        if (!parent || !parents.has(parent)) { root = cursor; break; }
        cursor = parent;
      }
      for (const item of path) this.roots.set(item, root);
    }
    // Merge whole connected families without replacing generation ancestry.
    const unions = new Map<string, string>();
    const find = (value: string): string => {
      const path: string[] = [];
      while (unions.has(value)) { path.push(value); value = unions.get(value)!; }
      for (const node of path) unions.set(node, value);
      return value;
    };
    for (const { node, linked } of links) {
      if (!this.roots.has(node) || !this.roots.has(linked)) continue;
      this.edges.get(node)!.push(linked); this.edges.get(linked)!.push(node);
      const left = find(this.roots.get(node)!), right = find(this.roots.get(linked)!);
      if (left !== right) unions.set(left < right ? right : left, left < right ? left : right);
    }
    for (const [node, root] of this.roots) this.roots.set(node, find(root));
  }

  public assetRoots(): readonly (readonly [string, string])[] {
    return [...this.roots].filter(([node]) => node.startsWith('a:')).map(([node, root]) => [node.slice(2), root]);
  }

  public family(start: string, limit = 1000): { nodes: string[]; truncated: boolean } {
    if (!this.edges.has(start)) return { nodes: [], truncated: false };
    const queue = [start], visited = new Set(queue);
    let index = 0;
    while (index < queue.length && queue.length <= limit) {
      for (const next of this.edges.get(queue[index++]!) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next); queue.push(next);
        if (queue.length > limit) break;
      }
    }
    return { nodes: queue.slice(0, limit), truncated: queue.length > limit };
  }
}

/** Load the account graph once. Hidden/deleted nodes still carry ancestry.
 * Uploaded-image membership follows asset origin, even when used as source/first frame. */
export function loadAssetSeriesGraph(database: AppDatabase, ownerId: string, groupConcurrentImages = false, groupUploadedReferences = false): AssetSeriesGraph {
  const nodes = database.all<SeriesNode>(sql`
    WITH owned_assets AS (SELECT id, type, role, job_id, parent_asset_id, metadata_json FROM assets WHERE owner_id = ${ownerId}),
    owned_jobs AS (
      SELECT j.id, CASE WHEN ${groupConcurrentImages ? 1 : 0} = 1 AND j.operation LIKE 'image.%' THEN b.batch_id END AS batch_id
      FROM jobs j LEFT JOIN job_generation_batches b ON b.job_id = j.id WHERE j.owner_id = ${ownerId}
    ),
    ranked_inputs AS (
      SELECT i.job_id, i.asset_id, (a.type = 'image' AND a.role IN ('upload', 'reference', 'first_frame', 'last_frame') AND a.job_id IS NULL AND coalesce(json_extract(a.metadata_json, '$.temporaryVideoFrame'), 0) != 1) AS uploaded, row_number() OVER (
        PARTITION BY i.job_id ORDER BY CASE i.role WHEN 'source' THEN 0 WHEN 'first_frame' THEN 1 ELSE 2 END, i.sort_order, i.asset_id
      ) AS rank FROM job_inputs i JOIN owned_jobs j ON j.id = i.job_id JOIN owned_assets a ON a.id = i.asset_id
      WHERE i.role IN ('source', 'first_frame', 'reference')
    )
    SELECT 'a:' || a.id AS node,
      CASE WHEN a.role = 'output' AND j.id IS NOT NULL THEN 'j:' || j.id
        WHEN a.role != 'output' AND coalesce(json_extract(a.metadata_json, '$.temporaryVideoFrame'), 0) = 1 AND p.id IS NOT NULL THEN 'a:' || p.id
        ELSE NULL END AS parent
    FROM owned_assets a LEFT JOIN owned_jobs j ON j.id = a.job_id LEFT JOIN owned_assets p ON p.id = a.parent_asset_id
    UNION ALL
    SELECT 'j:' || j.id AS node, coalesce('a:' || i.asset_id, 'b:' || j.batch_id) AS parent
    FROM owned_jobs j LEFT JOIN ranked_inputs i ON i.job_id = j.id AND i.rank = 1
      AND (${groupUploadedReferences ? 1 : 0} = 1 OR i.uploaded = 0)
    UNION ALL
    SELECT DISTINCT 'b:' || batch_id AS node, NULL AS parent FROM owned_jobs WHERE batch_id IS NOT NULL
  `);
  const links = database.all<{ node: string; linked: string }>(sql`
    SELECT 'a:' || l.asset_id AS node, 'a:' || l.linked_asset_id AS linked
    FROM asset_series_links l JOIN assets a ON a.id = l.asset_id JOIN assets b ON b.id = l.linked_asset_id
    WHERE a.owner_id = ${ownerId} AND b.owner_id = ${ownerId}
  `);
  return new AssetSeriesGraph(nodes, links);
}
