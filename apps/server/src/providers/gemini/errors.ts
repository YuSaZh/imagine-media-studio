export class GeminiValidationError extends Error {
  public override readonly name = 'GeminiValidationError';

  public constructor(
    message: string,
    public readonly code = 'gemini_validation_error',
  ) {
    super(message);
  }
}

export class GeminiTransportError extends Error {
  public override readonly name = 'GeminiTransportError';

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class GeminiHttpError extends Error {
  public override readonly name = 'GeminiHttpError';

  public constructor(
    message: string,
    public readonly statusCode: number,
    public readonly providerCode?: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export class GeminiResponseError extends Error {
  public override readonly name = 'GeminiResponseError';

  public constructor(
    message: string,
    public readonly code = 'gemini_invalid_response',
  ) {
    super(message);
  }
}

const SECRET_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'key',
  'secret',
  'token',
  'x-goog-api-key',
]);

export function redactSensitiveText(value: string, secrets?: Readonly<Record<string, string>>): string {
  let result = value;
  for (const secret of Object.values(secrets ?? {})) {
    if (secret.length > 0) result = result.split(secret).join('[REDACTED]');
  }

  result = result
    .replace(/((?:api[_-]?key|x-goog-api-key|authorization|bearer|token|secret)\s*[=:]\s*)[^\s,;"']+/giu, '$1[REDACTED]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(/([?&](?:access_token|api[_-]?key|apikey|key|secret|token|x-goog-api-key)=)[^&#\s]+/giu, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1[REDACTED]@');

  try {
    const url = new URL(result);
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.set(key, '[REDACTED]');
    }
    result = url.toString();
  } catch {
    // The message is not necessarily a URL.
  }
  return result;
}

export function normalizeProviderCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const normalized = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return normalized === '' ? undefined : normalized;
}
