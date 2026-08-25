import type {
  GenerationRequest,
} from '@imagine/shared';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContext,
  ProviderError,
  SubmitResult,
} from '@imagine/provider-contract';

import {
  GeminiHttpError,
  GeminiResponseError,
  GeminiTransportError,
  GeminiValidationError,
  normalizeProviderCode,
  redactSensitiveText,
} from './errors.js';
import {
  GEMINI_MAX_OUTPUT_ASSETS,
  liveGeminiCapabilities,
  staticGeminiCapabilities,
} from './catalog.js';
import { buildGeminiHeaders as mergeGeminiHeaders } from './headers.js';
import {
  buildGeminiGenerateContentPayload,
  buildGeminiGenerateContentUrl,
  GEMINI_DEFAULT_BASE_URL,
  GEMINI_PROFILE,
  getGeminiModelProfile,
} from './payload.js';
import { normalizeGeminiImageResponse } from './response.js';
import type {
  GeminiHttpResponse,
  GeminiHttpRequest,
  GeminiHttpRequestExecutor,
  GeminiHttpTransport,
  GeminiProviderContext,
  GeminiProviderOptions,
} from './types.js';

const MAX_RETRY_AFTER_MS = 86_400_000;

function contextWithGeminiFields(context: ProviderContext): GeminiProviderContext {
  return context as GeminiProviderContext;
}

function headerValue(
  headers:
    | Readonly<Record<string, string | readonly string[] | undefined>>
    | { get(name: string): string | null }
    | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  if ('get' in headers && typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = match?.[1];
  return typeof value === 'string' ? value : value?.[0];
}

function retryAfterMs(response: GeminiHttpResponse): number | undefined {
  const value = headerValue(response.headers, 'retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1_000), MAX_RETRY_AFTER_MS);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
  return undefined;
}

function statusErrorCode(statusCode: number): string {
  if (statusCode === 401 || statusCode === 403) return 'gemini_authentication_error';
  if (statusCode === 404) return 'gemini_model_not_found';
  if (statusCode === 408 || statusCode === 429) return 'gemini_rate_limited';
  if (statusCode === 413) return 'gemini_payload_too_large';
  if (statusCode >= 500) return 'gemini_upstream_error';
  return `gemini_http_${statusCode}`;
}

function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function safeErrorMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  return redactSensitiveText(value.trim()).slice(0, 1_000);
}

async function readResponseBody(response: GeminiHttpResponse): Promise<unknown> {
  try {
    if (typeof response.json === 'function') {
      try {
        return await response.json();
      } catch {
        // Empty and plain-text error responses are still classified by HTTP status.
      }
    }
    if (response.json !== undefined && typeof response.json !== 'function') return response.json;
    if (typeof response.body === 'string') {
      if (response.body.trim() === '') return undefined;
      try {
        return JSON.parse(response.body);
      } catch {
        return response.body;
      }
    }
    if (response.body instanceof Uint8Array) {
      if (response.body.byteLength === 0) return undefined;
      const text = Buffer.from(response.body).toString('utf8');
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    if (typeof response.text === 'function') {
      let text: string;
      try {
        text = await response.text();
      } catch {
        text = '';
      }
      if (text.trim() === '') return undefined;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    if (response.text !== undefined) {
      if (response.text.trim() === '') return undefined;
      try {
        return JSON.parse(response.text);
      } catch {
        return response.text;
      }
    }
    if (response.body === undefined) return undefined;
    return response.body;
  } finally {
    await response.dispose?.();
  }
}

function apiErrorFields(value: unknown): { code?: string; message?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const error = (value as Record<string, unknown>).error;
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return {};
  const record = error as Record<string, unknown>;
  return {
    ...(typeof record.status === 'string' ? { code: record.status } : {}),
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
  };
}

function responseErrorMessage(value: unknown, statusCode: number): string {
  const fields = apiErrorFields(value);
  if (fields.message !== undefined) return fields.message.slice(0, 1_000);
  if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 1_000);
  return `Gemini request failed with HTTP ${statusCode}.`;
}

function contextApiKey(context: GeminiProviderContext): string {
  const key = context.secrets.apiKey?.trim();
  if (!key) throw new GeminiValidationError('Gemini API key is required.', 'gemini_api_key_missing');
  if (/[\r\n]/u.test(key)) throw new GeminiValidationError('Gemini API key is invalid.', 'gemini_header_invalid');
  return key;
}

function contextBaseUrl(context: GeminiProviderContext, fallback: string | undefined): string {
  const configured =
    context.baseUrl?.trim() ||
    (typeof context.config?.baseUrl === 'string' ? context.config.baseUrl.trim() : '') ||
    fallback?.trim() ||
    GEMINI_DEFAULT_BASE_URL;
  return configured;
}

function modelsUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new GeminiValidationError('Gemini base URL is invalid.', 'gemini_base_url_invalid');
  }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new GeminiValidationError(
      'Gemini base URL must use HTTP or HTTPS without credentials, query, or fragment.',
      'gemini_base_url_invalid',
    );
  }
  const path = url.pathname.replace(/\/+$/u, '');
  if (path.endsWith(':generateContent')) {
    const match = /^(.*\/models)\/[^/:]+:generateContent$/u.exec(path);
    if (!match?.[1]) {
      throw new GeminiValidationError('Gemini generateContent URL must include a models/{model} path.', 'gemini_base_url_invalid');
    }
    url.pathname = match[1];
  } else {
    url.pathname = path.endsWith('/models') ? path : `${path}/models`;
  }
  return url.toString();
}

function resolveTransport(
  context: GeminiProviderContext,
  configured: GeminiHttpTransport | GeminiHttpRequestExecutor | undefined,
): GeminiHttpTransport | GeminiHttpRequestExecutor {
  const transport = configured ?? context.http ?? context.transport;
  if (!transport) {
    throw new GeminiTransportError(
      'Gemini requires an injected safe HTTP transport; no transport was configured.',
    );
  }
  return transport;
}

function secretHeaders(context: GeminiProviderContext): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(context.secrets)
      .filter(([name]) => name.startsWith('header:'))
      .map(([name, value]) => [name.slice('header:'.length), value]),
  );
}

function buildRequestHeaders(
  context: GeminiProviderContext,
  apiKey: string,
  configuredHeaders: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  return mergeGeminiHeaders(
    apiKey,
    [configuredHeaders, context.headers, context.config?.headers as Readonly<Record<string, unknown>> | undefined],
    secretHeaders(context),
  );
}

export class GeminiNativeImageProvider implements ProviderAdapter {
  public readonly type = GEMINI_PROFILE;

  private readonly transport: GeminiHttpTransport | GeminiHttpRequestExecutor | undefined;
  private readonly baseUrl: string | undefined;
  private readonly headers: Readonly<Record<string, string>> | undefined;

  public constructor(options: GeminiProviderOptions = {}) {
    this.transport = options.http ?? options.transport;
    this.baseUrl = options.baseUrl;
    this.headers = options.headers;
  }

  public async getCapabilities(_context: ProviderContext): Promise<ProviderCapabilities> {
    return staticGeminiCapabilities(this.type, false);
  }

  public async getLiveCapabilities(context: ProviderContext): Promise<ProviderCapabilities> {
    const geminiContext = contextWithGeminiFields(context);
    const apiKey = contextApiKey(geminiContext);
    const transport = resolveTransport(geminiContext, this.transport);
    const body = await this.requestModels(geminiContext, apiKey, transport);
    return liveGeminiCapabilities(this.type, body, false);
  }

  public async testConnection(context: ProviderContext): Promise<void> {
    const geminiContext = contextWithGeminiFields(context);
    const apiKey = contextApiKey(geminiContext);
    const transport = resolveTransport(geminiContext, this.transport);
    const request: GeminiHttpRequest = {
      method: 'GET',
      url: modelsUrl(contextBaseUrl(geminiContext, this.baseUrl)),
      headers: buildRequestHeaders(geminiContext, apiKey, this.headers),
      ...(geminiContext.signal === undefined ? {} : { signal: geminiContext.signal }),
    };
    geminiContext.signal?.throwIfAborted();
    let response: GeminiHttpResponse;
    try {
      response = typeof transport === 'function' ? await transport(request) : await transport.request(request);
    } catch (error) {
      if (error instanceof GeminiValidationError || error instanceof GeminiTransportError) throw error;
      throw new GeminiTransportError('Gemini connection request failed.');
    }
    const statusCode = response.statusCode ?? response.status;
    if (statusCode === undefined) {
      await response.dispose?.();
      throw new GeminiResponseError('Gemini HTTP response did not include a status code.');
    }
    if (statusCode < 200 || statusCode >= 300) {
      const body = await readResponseBody(response);
      const apiError = apiErrorFields(body);
      throw new GeminiHttpError(
        redactSensitiveText(responseErrorMessage(body, statusCode), geminiContext.secrets),
        statusCode,
        apiError.code,
        retryAfterMs(response),
      );
    }
    await response.dispose?.();
  }

  public async validate(request: GenerationRequest, context: ProviderContext): Promise<void> {
    const geminiContext = contextWithGeminiFields(context);
    contextApiKey(geminiContext);
    buildGeminiGenerateContentPayload(request, geminiContext);
    buildGeminiGenerateContentUrl(contextBaseUrl(geminiContext, this.baseUrl), request.modelId);
  }

  public async submit(request: GenerationRequest, context: ProviderContext): Promise<SubmitResult> {
    const geminiContext = contextWithGeminiFields(context);
    const payload = buildGeminiGenerateContentPayload(request, geminiContext);
    const apiKey = contextApiKey(geminiContext);
    const url = buildGeminiGenerateContentUrl(contextBaseUrl(geminiContext, this.baseUrl), request.modelId);
    const headers = buildRequestHeaders(geminiContext, apiKey, this.headers);
    const transport = resolveTransport(geminiContext, this.transport);
    geminiContext.signal?.throwIfAborted();

    let response: GeminiHttpResponse;
    try {
      const httpRequest = {
        method: 'POST',
        url,
        headers,
        body: JSON.stringify(payload),
        ...(geminiContext.signal === undefined ? {} : { signal: geminiContext.signal }),
      } as const;
      response = typeof transport === 'function'
        ? await transport(httpRequest)
        : await transport.request(httpRequest);
    } catch (error) {
      if (error instanceof GeminiValidationError || error instanceof GeminiTransportError) throw error;
      throw new GeminiTransportError('Gemini HTTP request failed.', { cause: error });
    }

    const statusCode = response.statusCode ?? response.status;
    if (statusCode === undefined) {
      await response.dispose?.();
      throw new GeminiResponseError('Gemini HTTP response did not include a status code.');
    }
    if (statusCode < 200 || statusCode >= 300) {
      const body = await readResponseBody(response);
      const apiError = apiErrorFields(body);
      const message = redactSensitiveText(
        safeErrorMessage(responseErrorMessage(body, statusCode), `Gemini request failed with HTTP ${statusCode}.`),
        geminiContext.secrets,
      );
      throw new GeminiHttpError(
        message,
        statusCode,
        apiError.code,
        retryAfterMs(response),
      );
    }

    const body = await readResponseBody(response);
    if (body === undefined) throw new GeminiResponseError('Gemini response body is empty.');

    return {
      state: 'completed',
      assets: normalizeGeminiImageResponse(body, { maxAssets: GEMINI_MAX_OUTPUT_ASSETS }),
    };
  }

  private async requestModels(
    context: GeminiProviderContext,
    apiKey: string,
    transport: GeminiHttpTransport | GeminiHttpRequestExecutor,
  ): Promise<unknown> {
    const request: GeminiHttpRequest = {
      method: 'GET',
      url: modelsUrl(contextBaseUrl(context, this.baseUrl)),
      headers: buildRequestHeaders(context, apiKey, this.headers),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    };
    context.signal?.throwIfAborted();
    let response: GeminiHttpResponse;
    try {
      response = typeof transport === 'function' ? await transport(request) : await transport.request(request);
    } catch (error) {
      if (error instanceof GeminiValidationError || error instanceof GeminiTransportError) throw error;
      throw new GeminiTransportError('Gemini model catalog request failed.');
    }
    const statusCode = response.statusCode ?? response.status;
    if (statusCode === undefined) {
      await response.dispose?.();
      throw new GeminiResponseError('Gemini HTTP response did not include a status code.');
    }
    if (statusCode < 200 || statusCode >= 300) {
      const body = await readResponseBody(response);
      const apiError = apiErrorFields(body);
      throw new GeminiHttpError(
        redactSensitiveText(responseErrorMessage(body, statusCode), context.secrets),
        statusCode,
        apiError.code,
        retryAfterMs(response),
      );
    }
    const body = await readResponseBody(response);
    if (body === undefined) throw new GeminiResponseError('Gemini models response body is empty.');
    return body;
  }

  public normalizeError(error: unknown): ProviderError {
    if (error instanceof GeminiValidationError) {
      return {
        code: error.code,
        kind: 'rejected',
        message: redactSensitiveText(error.message),
        retryable: false,
      };
    }
    if (error instanceof GeminiHttpError) {
      const retryable = isRetryableStatus(error.statusCode);
      const providerCode = normalizeProviderCode(error.providerCode);
      const code =
        error.statusCode === 429
          ? 'gemini_rate_limited'
          : error.statusCode === 401 || error.statusCode === 403
            ? 'gemini_authentication_error'
            : providerCode === undefined
              ? statusErrorCode(error.statusCode)
              : `gemini_${providerCode}`;
      return {
        code,
        kind: retryable ? 'transient' : 'rejected',
        message: redactSensitiveText(error.message),
        retryable,
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
        statusCode: error.statusCode,
      };
    }
    if (error instanceof GeminiResponseError) {
      return {
        code: error.code,
        kind: error.code === 'gemini_content_blocked' ? 'rejected' : 'unknown',
        message: redactSensitiveText(error.message),
        retryable: false,
      };
    }
    if (error instanceof GeminiTransportError) {
      if (error.cause instanceof Error && (error.cause.name === 'AbortError' || error.cause.name === 'CanceledError')) {
        return {
          code: 'gemini_request_aborted',
          kind: 'transient',
          message: 'The Gemini request was aborted.',
          retryable: false,
        };
      }
      return {
        code: 'gemini_transport_error',
        kind: 'transient',
        message: redactSensitiveText(error.message),
        retryable: true,
      };
    }
    const message = error instanceof Error ? error.message : 'Gemini request failed before a response was received.';
    return {
      code: 'gemini_network_error',
      kind: 'transient',
      message: redactSensitiveText(message),
      retryable: true,
    };
  }

  public async poll(_remoteJobId: string, _context: ProviderContext): Promise<never> {
    throw new GeminiValidationError(
      'Gemini generateContent image generation is synchronous and does not support polling.',
      'gemini_poll_unsupported',
    );
  }
}

export {
  GeminiNativeImageProvider as GeminiGenerateContentImageProvider,
  GeminiNativeImageProvider as GeminiGenerateContentImageAdapter,
  getGeminiModelProfile,
};
export default GeminiNativeImageProvider;
