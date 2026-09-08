import { and, sql, type SQL } from 'drizzle-orm';
import { assets, collectionAssets, collections, jobs } from './schema.js';

export function assetOutsidePrivateProjects(): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${collectionAssets} INNER JOIN ${collections}
      ON ${collectionAssets.collectionId} = ${collections.id}
    WHERE ${collectionAssets.assetId} = ${assets.id}
      AND ${collections.isPrivate} = 1 AND ${collections.ownerId} = ${assets.ownerId}
  )`;
}

export function jobOutsidePrivateProjects(): SQL {
  return and(sql`NOT EXISTS (
    SELECT 1 FROM ${collections}
    WHERE ${collections.id} = json_extract(${jobs.requestJson}, '$.collectionId')
      AND ${collections.isPrivate} = 1 AND ${collections.ownerId} = ${jobs.ownerId}
  )`, sql`NOT EXISTS (
    SELECT 1 FROM ${assets} INNER JOIN ${collectionAssets} ON ${assets.id} = ${collectionAssets.assetId}
      INNER JOIN ${collections} ON ${collections.id} = ${collectionAssets.collectionId}
    WHERE ${assets.jobId} = ${jobs.id} AND ${assets.deletedAt} IS NULL
      AND ${collections.isPrivate} = 1 AND ${collections.ownerId} = ${jobs.ownerId}
  )`)!;
}
