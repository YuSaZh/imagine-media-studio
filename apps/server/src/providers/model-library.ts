import { compatibleModelIdentity, type ModelCapabilities } from '@imagine/shared';

export interface ModelTemplate { modelId: string; displayName: string; capabilities: ModelCapabilities }
// Aliases are reviewed entries, not a grammar that grants capabilities to future IDs.
const ALIASES: Readonly<Record<string, string>> = {
  'gemini-3.1-flash-image-preview': 'gemini-3.1-flash-image',
  'gemini-3-pro-image-preview': 'gemini-3-pro-image',
  'gemini-2.5-flash-image-preview': 'gemini-2.5-flash-image',
  'gpt-image-2-2026-04-21': 'gpt-image-2',
  'sora-2-2025-10-06': 'sora-2', 'sora-2-2025-12-08': 'sora-2', 'sora-2-pro-2025-10-06': 'sora-2-pro',
};
export function canonicalLibraryModel(id: string): string {
  const canonical = id.trim().replace(/^models\//, '');
  return compatibleModelIdentity(canonical)?.id ?? ALIASES[canonical] ?? canonical;
}
export function matchLibraryModel(models: readonly ModelTemplate[], id: string, profile?: string): ModelTemplate | undefined {
  const eligible = models.filter(model => !profile || model.capabilities.profile === profile);
  return eligible.find(model => model.modelId === id) ?? eligible.find(model => canonicalLibraryModel(model.modelId) === canonicalLibraryModel(id));
}
