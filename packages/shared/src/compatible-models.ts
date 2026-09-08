// Reviewed identities only. Wire IDs remain the user's original catalog IDs.
// Capabilities and source/region caveats live in docs/model-capabilities.md.
export interface CompatibleModelIdentity {
  id: string; name: string; aliases: readonly string[]; kind: 'image' | 'video';
}
export const COMPATIBLE_MODEL_IDENTITIES: readonly CompatibleModelIdentity[] = [
  ...['2', '2e', '2.5', '2.5-Pro', '2.5-Flash', '2.6', '2.6-Flash'].map(version => ({ id: `MAI-Image-${version}`, name: `MAI Image ${version}`, aliases: [`mai-image-${version.toLowerCase()}`], kind: 'image' as const })),
  { id: 'doubao-seedream-4-0-250828', name: 'Seedream 4.0', aliases: ['seedream-4-0-250828'], kind: 'image' },
  { id: 'doubao-seedream-4-5-251128', name: 'Seedream 4.5', aliases: ['seedream-4-5-251128'], kind: 'image' },
  { id: 'doubao-seedream-5-0-260128', name: 'Seedream 5.0 Lite', aliases: ['doubao-seedream-5-0-lite-260128', 'seedream-5-0-260128', 'seedream-5-0-lite-260128', 'dola-seedream-5-0-lite-260128'], kind: 'image' },
  { id: 'dola-seedream-5-0-pro-260628', name: 'Seedream 5.0 Pro', aliases: [], kind: 'image' },
  { id: 'doubao-seedance-1-0-pro-250528', name: 'Seedance 1.0 Pro', aliases: ['bytedance-seedance-1-0-pro-250528', 'seedance-1-0-pro-250528'], kind: 'video' },
  { id: 'bytedance-seedance-1-0-pro-fast-251015', name: 'Seedance 1.0 Pro Fast', aliases: ['doubao-seedance-1-0-pro-fast-251015'], kind: 'video' },
  { id: 'doubao-seedance-1-0-lite-t2v-250428', name: 'Seedance 1.0 Lite T2V', aliases: ['bytedance-seedance-1-0-lite-t2v-250428'], kind: 'video' },
  { id: 'doubao-seedance-1-0-lite-i2v-250428', name: 'Seedance 1.0 Lite I2V', aliases: ['bytedance-seedance-1-0-lite-i2v-250428'], kind: 'video' },
  { id: 'doubao-seedance-1-5-pro-251215', name: 'Seedance 1.5 Pro', aliases: ['seedance-1-5-pro-251215'], kind: 'video' },
  { id: 'dreamina-seedance-2-0-260128', name: 'Seedance 2.0', aliases: ['doubao-seedance-2-0-260128'], kind: 'video' },
  { id: 'dreamina-seedance-2-0-fast-260128', name: 'Seedance 2.0 Fast', aliases: ['doubao-seedance-2-0-fast-260128'], kind: 'video' },
  { id: 'dreamina-seedance-2-0-mini-260615', name: 'Seedance 2.0 Mini', aliases: [], kind: 'video' },
  { id: 'dreamina-seedance-2-5-260628', name: 'Seedance 2.5', aliases: [], kind: 'video' },
];
export function compatibleModelIdentity(id: string): CompatibleModelIdentity | undefined {
  const normalized = id.trim().replace(/^models\//, '');
  return COMPATIBLE_MODEL_IDENTITIES.find(model => model.id === normalized || model.aliases.includes(normalized));
}
