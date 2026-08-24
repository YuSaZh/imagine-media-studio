import { z } from 'zod';

export const AppInfoSchema = z.object({
  name: z.literal('Imagine Media Studio'),
  version: z.string(),
  mockProviderEnabled: z.boolean(),
});

export type AppInfo = z.infer<typeof AppInfoSchema>;
