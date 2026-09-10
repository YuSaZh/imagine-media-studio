import type { JsonObject, JsonValue } from '@imagine/shared';

export function generationMemoryScope(projectId: string | null, assetId?: string): string {
  const project = projectId ?? 'default';
  return assetId === undefined ? project : `edit.${project}.${assetId}`;
}

export function generationMemoryKey(projectId: string | null): string {
  return `generation.${generationMemoryScope(projectId)}`;
}

export function memoryObject(value: JsonValue | undefined): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

export function readGenerationMemory(settings: JsonObject | undefined, projectId: string | null, mode: 'image' | 'video'): JsonObject {
  return memoryObject(memoryObject(settings?.[generationMemoryKey(projectId)])[mode]);
}

export function updateGenerationMemory(settings: JsonObject | undefined, projectId: string | null, mode: 'image' | 'video', update: JsonObject): JsonObject {
  const key = generationMemoryKey(projectId);
  const project = memoryObject(settings?.[key]);
  return { [key]: { ...project, [mode]: { ...memoryObject(project[mode]), ...update } } };
}
