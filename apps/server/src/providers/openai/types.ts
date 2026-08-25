import type {
  ProviderContext,
  ProviderError,
  ProviderInput,
  SubmittedAsset,
} from '@imagine/provider-contract';

export type OpenAiProfile = 'openai-images-v1' | 'openai-responses-image-v1';

export const OPENAI_IMAGES_PROFILE = 'openai-images-v1' as const;
export const OPENAI_RESPONSES_IMAGE_PROFILE = 'openai-responses-image-v1' as const;
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1' as const;
export const OPENAI_IMAGES_DEFAULT_BASE_URL = OPENAI_DEFAULT_BASE_URL;

export type OpenAiHttpBody = string;

export interface OpenAiHttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: OpenAiHttpBody;
  /** Binary multipart bytes for transports that do not want a latin-1 body string. */
  readonly bodyBytes?: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface OpenAiHttpResponse {
  readonly status?: number;
  readonly statusCode?: number;
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>> | {
    get(name: string): string | null;
  };
  readonly body?: unknown;
  readonly json?: unknown | (() => Promise<unknown>);
  readonly text?: string | (() => Promise<string>);
  readonly dispose?: () => void | Promise<void>;
}

/**
 * The provider never calls fetch directly. Production wires this port to the
 * server's pinned, policy-checked HTTP implementation and tests use a fixture
 * executor.
 */
export interface OpenAiHttpTransport {
  request(request: OpenAiHttpRequest): Promise<OpenAiHttpResponse>;
}

export type OpenAiHttpRequestExecutor = (
  request: OpenAiHttpRequest,
) => Promise<OpenAiHttpResponse>;

export interface OpenAiInputAsset {
  readonly assetId: string;
  readonly role: 'source' | 'reference' | 'mask';
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly filename?: string;
  readonly parentAssetId?: string | null;
  readonly width?: number;
  readonly height?: number;
}

export type OpenAiAssetResolver = (
  assetId: string,
  context: ProviderContext,
) => ProviderInput | Promise<ProviderInput>;

export interface OpenAiProviderOptions {
  readonly http?: OpenAiHttpTransport | OpenAiHttpRequestExecutor;
  /** Alias kept for integrations that call the injected port transport. */
  readonly transport?: OpenAiHttpTransport | OpenAiHttpRequestExecutor;
  readonly profile: OpenAiProfile;
  readonly baseUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly models?: readonly string[];
  readonly resolveAsset?: OpenAiAssetResolver;
}

export interface OpenAiRuntimeContext extends ProviderContext {
  /** Added by the server integration without changing the shared contract. */
  readonly baseUrl?: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly inputs?: readonly (ProviderInput & {
    readonly parentAssetId?: string | null;
    readonly width?: number;
    readonly height?: number;
  })[];
  readonly http?: OpenAiHttpTransport | OpenAiHttpRequestExecutor;
  readonly transport?: OpenAiHttpTransport | OpenAiHttpRequestExecutor;
}

export type OpenAiProviderContext = OpenAiRuntimeContext;
export type OpenAiImageInput = OpenAiInputAsset;
export type OpenAiHttpHeaders = NonNullable<OpenAiHttpResponse['headers']>;

const MAX_ERROR_TEXT_LENGTH = 512;
const MAX_SECRET_LENGTH = 16_384;
const MAX_SECRET_VALUES = 128;
const MAX_ERROR_VALUE_DEPTH = 5;
const MAX_ERROR_OBJECT_KEYS = 32;
const SENSITIVE_ERROR_KEY = /(?:api[-_]?key|authorization|proxy[-_]?authorization|cookie|password|secret|token|credential|signature|idempotency[-_]?key)/iu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function redactErrorUrl(value: string): string {
  return value.replace(/\bhttps?:\/\/[^\s"'<>]+/giu, (rawUrl) => {
    const trailing = rawUrl.match(/[),.;]+$/u)?.[0] ?? '';
    const candidate = trailing === '' ? rawUrl : rawUrl.slice(0, -trailing.length);
    try {
      const url = new URL(candidate);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return `${url.toString()}${trailing}`;
    } catch {
      return '[REDACTED_URL]';
    }
  });
}

export function redactOpenAiErrorText(
  message: string,
  secrets: Readonly<Record<string, string>> = {},
): string {
  // Keep the scan bounded while retaining enough suffix to redact a maximum-size
  // API key that begins inside the visible error prefix.
  let result = message.slice(0, MAX_ERROR_TEXT_LENGTH + MAX_SECRET_LENGTH - 1);
  const secretEntries = Object.entries(secrets);
  const prioritizedSecrets = [
    ...secretEntries.filter(([key]) => /^(?:api[-_]?key)$/iu.test(key)),
    ...secretEntries.filter(([key]) => !/^(?:api[-_]?key)$/iu.test(key)),
  ];
  for (const [, secret] of prioritizedSecrets.slice(0, MAX_SECRET_VALUES)) {
    if (secret.length === 0 || secret.length > MAX_SECRET_LENGTH) continue;
    result = result.replace(new RegExp(escapeRegExp(secret), 'gu'), '[REDACTED]');
  }
  result = result
    .replace(/\bBearer\s+[^\s,;}]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:api[-_]?key|x[-_]?api[-_]?key|authorization|proxy[-_]?authorization|token|secret|password|credential|signature)\s*[:=]\s*["']?[^\s,"'}]+["']?/giu, '$1=[REDACTED]')
    .replace(/\b(?:sk|sess|key)[-_][A-Za-z0-9._~-]{8,}/gu, '[REDACTED]');
  return redactErrorUrl(result).slice(0, MAX_ERROR_TEXT_LENGTH);
}

function redactOpenAiErrorValueInternal(
  value: unknown,
  secrets: Readonly<Record<string, string>>,
  depth: number,
): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactOpenAiErrorText(value, secrets);
  if (value instanceof Uint8Array) return '[REDACTED_BYTES]';
  if (depth >= MAX_ERROR_VALUE_DEPTH) return '[REDACTED_NESTED_VALUE]';
  if (Array.isArray(value)) {
    const values = value.slice(0, MAX_ERROR_OBJECT_KEYS).map((item) =>
      redactOpenAiErrorValueInternal(item, secrets, depth + 1));
    if (value.length > MAX_ERROR_OBJECT_KEYS) values.push('[TRUNCATED]');
    return values;
  }
  if (typeof value !== 'object') return '[REDACTED_VALUE]';
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_ERROR_OBJECT_KEYS)) {
    output[key] = SENSITIVE_ERROR_KEY.test(key)
      ? '[REDACTED]'
      : redactOpenAiErrorValueInternal(item, secrets, depth + 1);
  }
  if (Object.keys(value).length > MAX_ERROR_OBJECT_KEYS) output._truncated = true;
  return output;
}

export function redactOpenAiErrorValue(
  value: unknown,
  secrets: Readonly<Record<string, string>> = {},
): unknown {
  return redactOpenAiErrorValueInternal(value, secrets, 0);
}

function redactOpenAiErrorHeaders(
  headers: OpenAiHttpResponse['headers'],
  secrets: Readonly<Record<string, string>>,
): OpenAiHttpResponse['headers'] {
  if (headers === undefined) return undefined;
  if ('get' in headers && typeof headers.get === 'function') {
    const retryAfter = headers.get('retry-after');
    return retryAfter === null ? undefined : { 'retry-after': redactOpenAiErrorText(retryAfter, secrets) };
  }
  return redactOpenAiErrorValue(headers, secrets) as OpenAiHttpResponse['headers'];
}

export interface OpenAiMultipartPart {
  readonly name: string;
  readonly filename?: string;
  readonly contentType?: string;
  readonly bytes: Uint8Array;
}

export interface OpenAiImagePartial {
  readonly index: number;
  readonly base64: string;
  readonly mimeType: string;
}

export interface OpenAiStreamResult {
  readonly partials: readonly OpenAiImagePartial[];
  readonly assets: readonly SubmittedAsset[];
  readonly done: boolean;
}

export class OpenAiValidationError extends Error {
  public override readonly name: string = 'OpenAiValidationError';

  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.code = code.startsWith('openai_') ? code : `openai_${code}`;
  }
}

export class OpenAiHttpError extends Error {
  public override readonly name = 'OpenAiHttpError';

  public readonly statusCode: number;
  public readonly responseBody?: unknown;
  public readonly responseHeaders?: OpenAiHttpResponse['headers'];

  public constructor(
    statusCode: number,
    messageOrBody?: string | unknown,
    responseBodyOrHeaders?: unknown | OpenAiHttpResponse['headers'],
    responseHeaders?: OpenAiHttpResponse['headers'],
    secrets: Readonly<Record<string, string>> = {},
  ) {
    const hasExplicitMessage = typeof messageOrBody === 'string';
    const message = hasExplicitMessage
      ? messageOrBody as string
      : `OpenAI returned HTTP ${statusCode}.`;
    super(redactOpenAiErrorText(message, secrets));
    this.statusCode = statusCode;
    if (hasExplicitMessage) {
      this.responseBody = redactOpenAiErrorValue(responseBodyOrHeaders, secrets);
      this.responseHeaders = redactOpenAiErrorHeaders(responseHeaders, secrets);
    } else {
      this.responseBody = redactOpenAiErrorValue(messageOrBody, secrets);
      this.responseHeaders = redactOpenAiErrorHeaders(responseBodyOrHeaders as OpenAiHttpResponse['headers'], secrets);
    }
  }
}

export class OpenAiTransportError extends Error {
  public override readonly name = 'OpenAiTransportError';
}

export class OpenAiResponseError extends OpenAiValidationError {
  public override readonly name = 'OpenAiResponseError';
}

export type OpenAiNormalizedError = ProviderError;
