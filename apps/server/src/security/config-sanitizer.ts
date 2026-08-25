import { SafeConfigSchema, type JsonValue } from '@imagine/shared';

const SECRET_LIKE_KEY = /(?:^|[-_.])(api[-_.]?key|authorization|cookie|password|secret|token|headers?|custom[-_.]?headers?)(?:$|[-_.])/i;

export function isSecretLikeKey(value: string): boolean {
  return SECRET_LIKE_KEY.test(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const sanitized = sanitizeValue(item);
      return sanitized === undefined ? [] : [sanitized];
    });
  }
  if (!isRecord(value)) return undefined;
  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretLikeKey(key)) continue;
    const sanitized = sanitizeValue(child);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

export function sanitizeLegacyJsonValue(value: unknown): JsonValue | null {
  return sanitizeValue(value) ?? null;
}

export function safeProviderConfig(value: unknown): Readonly<Record<string, unknown>> {
  const parsed = SafeConfigSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const sanitized = sanitizeValue(value);
  return isRecord(sanitized) ? sanitized as Readonly<Record<string, unknown>> : {};
}
