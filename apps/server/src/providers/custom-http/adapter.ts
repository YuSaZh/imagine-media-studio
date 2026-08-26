import type {
  PollResult,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContext,
  ProviderError,
  ProviderModel,
  SubmitResult,
} from '@imagine/provider-contract';
import type { GenerationRequest } from '@imagine/shared';
import { UnsafeRemoteUrlError } from '../../security/network-policy.js';
import { ProviderHttpError } from '../provider-http-client.js';

import {
  assertDeclarativeBaseUrl,
  compileEndpoint,
  compileDeclarativeRequest,
  encodeCompiledBody,
  type CompiledRequest,
  DeclarativeCompileError,
} from './compiler.js';
import {
  extractCatalog,
  extractDeclarativeResponse,
  type DeclarativeResponse,
} from './extractor.js';
import {
  DECLARATIVE_HTTP_ADAPTER_TYPE,
  MAX_RESPONSE_JSON_BYTES,
  type DeclarativeEndpoint,
  type DeclarativeHttpSpec,
} from './schema.js';
import { DeclarativeResponseError } from './extractor.js';

export interface DeclarativeHttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly bodyBytes?: Uint8Array;
  /** Shared transport must enforce this before parsing a response body. */
  readonly maxResponseBodyBytes: number;
  readonly signal?: AbortSignal;
}

export interface DeclarativeHttpResponse extends DeclarativeResponse {
  readonly statusCode?: number;
  readonly dispose?: () => Promise<void> | void;
}

export interface DeclarativeHttpClient {
  request(request: DeclarativeHttpRequest): Promise<DeclarativeHttpResponse>;
}

export interface DeclarativeHttpAdapterOptions {
  readonly http?: DeclarativeHttpClient;
}

export class DeclarativeProviderOperationError extends Error {
  public override readonly name = 'DeclarativeProviderOperationError';
  public constructor(public readonly providerError: ProviderError) {
    super(providerError.message);
  }
}

function runtimeContext(context: ProviderContext): ProviderContext & { readonly http?: DeclarativeHttpClient } {
  return context as ProviderContext & { readonly http?: DeclarativeHttpClient };
}

function safeProviderError(error: ProviderError): ProviderError {
  const redact = (value: string): string => value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]+/gu, '[REDACTED]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|token|secret|password|signature|authorization|auth|credential(?:s)?|idempotency[-_]?key|cookie|set-cookie)\s*[=:]\s*[^\s,;]+/giu, '[REDACTED]');
  const code = redact(error.code);
  return {
    code: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(code) ? code : 'provider_error',
    kind: error.kind,
    message: redact(error.message).slice(0, 512),
    retryable: error.retryable,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: Math.min(Math.max(0, error.retryAfterMs), 86_400_000) }),
    ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
  };
}

function responseFromHttp(response: DeclarativeHttpResponse): DeclarativeResponse {
  return {
    ...(response.body === undefined ? {} : { body: response.body }),
    ...(response.headers === undefined ? {} : { headers: response.headers }),
    ...(response.json === undefined ? {} : { json: response.json }),
    ...(response.text === undefined ? {} : { text: response.text }),
    status: response.status ?? response.statusCode ?? 0,
  };
}

interface PerformedResponse {
  readonly response: DeclarativeResponse;
  readonly sensitiveValues: readonly string[];
}

export class DeclarativeHttpAdapter implements ProviderAdapter {
  public readonly type = DECLARATIVE_HTTP_ADAPTER_TYPE;
  public readonly poll?: (remoteJobId: string, context: ProviderContext) => Promise<PollResult>;
  public readonly cancel?: (remoteJobId: string, context: ProviderContext) => Promise<void>;

  public constructor(
    private readonly spec: DeclarativeHttpSpec,
    private readonly options: DeclarativeHttpAdapterOptions = {},
  ) {
    if (spec.poll !== undefined) this.poll = this.pollOperation.bind(this);
    if (spec.cancel !== undefined) this.cancel = this.cancelOperation.bind(this);
  }

  public async getCapabilities(_context: ProviderContext): Promise<ProviderCapabilities> {
    return {
      providerType: this.type,
      models: this.spec.models.map((model) => ({
        capabilities: model.capabilities as unknown as ProviderModel['capabilities'],
        displayName: model.displayName,
        id: model.id,
      })),
    };
  }

  public async getLiveCapabilities(context: ProviderContext): Promise<ProviderCapabilities> {
    if (this.spec.catalog === undefined) return this.getCapabilities(context);
    const performed = await this.perform(this.spec.catalog, this.spec.models[0]?.id ?? '', context, 'catalog');
    const knownModels = new Set(this.spec.models.map((model) => model.id));
    const catalog = extractCatalog(this.spec.catalog, performed.response, knownModels);
    return {
      providerType: this.type,
      models: catalog.flatMap((model) => {
        const known = this.spec.models.find((candidate) => candidate.id === model.id);
        if (known === undefined) return [];
        return [{
          capabilities: known.capabilities as unknown as ProviderModel['capabilities'],
          displayName: known.displayName,
          id: model.id,
        }];
      }),
    };
  }

  public async testConnection(context: ProviderContext): Promise<void> {
    if (this.spec.connection === undefined) throw new DeclarativeProviderOperationError({ code: 'connection_not_configured', kind: 'rejected', message: 'Provider connection endpoint is not configured.', retryable: false });
    const performed = await this.perform(this.spec.connection, this.spec.models[0]?.id ?? '', context, 'connection');
    const extracted = extractDeclarativeResponse(this.spec.connection, performed.response, 'connection', performed.sensitiveValues);
    if (extracted.state === 'failed') throw new DeclarativeProviderOperationError(extracted.error);
  }

  public async validate(request: GenerationRequest, context: ProviderContext): Promise<void> {
    compileDeclarativeRequest(this.spec, request, context, this.spec.submit, { mode: 'redacted' });
  }

  public async submit(request: GenerationRequest, context: ProviderContext): Promise<SubmitResult> {
    const performed = await this.perform(this.spec.submit, request.modelId, context, 'submit', request);
    const extracted = extractDeclarativeResponse(this.spec.submit, performed.response, 'submit', performed.sensitiveValues);
    if (extracted.state === 'failed') throw new DeclarativeProviderOperationError(extracted.error);
    if (extracted.state === 'pending') {
      if (extracted.remoteJobId === undefined) throw new DeclarativeProviderOperationError({ code: 'remote_id_missing', kind: 'unknown', message: 'Provider response did not contain a remote job ID.', retryable: false });
      return { state: 'pending', remoteJobId: extracted.remoteJobId, ...(extracted.resultExpiresAt === undefined ? {} : { resultExpiresAt: extracted.resultExpiresAt }) };
    }
    return { assets: extracted.assets, state: 'completed', ...(extracted.resultExpiresAt === undefined ? {} : { resultExpiresAt: extracted.resultExpiresAt }) };
  }

  private async pollOperation(remoteJobId: string, context: ProviderContext): Promise<PollResult> {
    const endpoint = this.spec.poll;
    if (endpoint === undefined) throw new DeclarativeProviderOperationError({ code: 'poll_not_configured', kind: 'rejected', message: 'Provider polling endpoint is not configured.', retryable: false });
    const performed = await this.perform(endpoint, context.modelId ?? this.spec.models[0]?.id ?? '', { ...context, remoteJobId }, 'poll');
    const extracted = extractDeclarativeResponse(endpoint, performed.response, 'poll', performed.sensitiveValues, remoteJobId);
    if (extracted.state === 'failed') return { error: safeProviderError(extracted.error), state: 'failed' };
    if (extracted.state === 'pending') return { state: extracted.status !== undefined && endpoint.extract.pendingValues?.includes(extracted.status) ? 'remote_pending' : 'remote_running', ...(extracted.progress === undefined ? {} : { progress: extracted.progress }), ...(extracted.resultExpiresAt === undefined ? {} : { resultExpiresAt: extracted.resultExpiresAt }) };
    return { assets: extracted.assets, state: 'completed', ...(extracted.resultExpiresAt === undefined ? {} : { resultExpiresAt: extracted.resultExpiresAt }) };
  }

  private async cancelOperation(remoteJobId: string, context: ProviderContext): Promise<void> {
    const endpoint = this.spec.cancel;
    if (endpoint === undefined) throw new DeclarativeProviderOperationError({ code: 'cancel_not_configured', kind: 'rejected', message: 'Provider cancellation endpoint is not configured.', retryable: false });
    const performed = await this.perform(endpoint, context.modelId ?? this.spec.models[0]?.id ?? '', { ...context, remoteJobId }, 'cancel');
    const extracted = extractDeclarativeResponse(endpoint, performed.response, 'cancel', performed.sensitiveValues);
    if (extracted.state === 'failed') throw new DeclarativeProviderOperationError(extracted.error);
  }

  public normalizeError(error: unknown): ProviderError {
    if (error instanceof DeclarativeProviderOperationError) return safeProviderError(error.providerError);
    if (error instanceof DeclarativeCompileError) return { code: error.code, kind: 'rejected', message: 'Declarative provider request was rejected.', retryable: false };
    if (error instanceof DeclarativeResponseError) return { code: error.code, kind: 'rejected', message: 'Declarative provider response was invalid.', retryable: false };
    if (error instanceof UnsafeRemoteUrlError) return { code: 'unsafe_remote_url', kind: 'rejected', message: 'Declarative provider target was rejected by network policy.', retryable: false };
    if (error instanceof ProviderHttpError) {
      const deterministic = new Set(['invalid_request', 'request_body_too_large', 'response_body_too_large', 'response_invalid', 'redirect_not_allowed']);
      if (error.code === 'aborted') return safeProviderError({ code: 'aborted', kind: 'unknown', message: 'Provider request was aborted.', retryable: false });
      if (deterministic.has(error.code)) return safeProviderError({ code: error.code, kind: 'rejected', message: 'Declarative provider HTTP request was rejected.', retryable: false });
      return safeProviderError({ code: error.code, kind: 'transient', message: 'Declarative provider HTTP request failed.', retryable: true });
    }
    if (error instanceof Error && error.name === 'AbortError') return { code: 'aborted', kind: 'unknown', message: 'Provider request was aborted.', retryable: false };
    return { code: 'provider_unknown', kind: 'unknown', message: 'Declarative provider request failed.', retryable: false };
  }

  private async perform(
    endpoint: DeclarativeEndpoint,
    modelId: string,
    context: ProviderContext & { readonly remoteJobId?: string },
    phase: 'submit' | 'poll' | 'cancel' | 'connection' | 'catalog',
    request?: GenerationRequest,
  ): Promise<PerformedResponse> {
    const http = runtimeContext(context).http ?? this.options.http;
    if (http === undefined) throw new DeclarativeProviderOperationError({ code: 'http_not_configured', kind: 'rejected', message: 'Provider HTTP client is not configured.', retryable: false });
    const operation = request ?? {
      operation: this.spec.operations[0]!,
      providerId: context.providerId,
      modelId,
      prompt: '',
      inputs: [],
    };
    const endpointContext = {
      ...context,
      ...(context.remoteJobId === undefined ? {} : { remoteJobId: context.remoteJobId }),
    };
    // Poll, cancel, catalog, and connection are endpoint/template operations;
    // only submit is allowed to validate the generation request and inputs.
    const compiled = phase === 'submit'
      ? compileDeclarativeRequest(this.spec, operation, endpointContext, endpoint, { mode: 'runtime' })
      : compileEndpoint(endpoint, operation, endpointContext, { mode: 'runtime', allowedExtraFields: this.allowedExtraFields(modelId) });
    const url = composeUrl(context.baseUrl, compiled);
    const encoded = encodeCompiledBody(compiled.body);
    const headers = { ...compiled.headers, ...(encoded.contentType === undefined ? {} : { 'Content-Type': encoded.contentType }) };
    let response: DeclarativeHttpResponse | undefined;
    try {
      response = await http.request({
        ...encoded,
        headers,
        maxResponseBodyBytes: MAX_RESPONSE_JSON_BYTES,
        method: compiled.method,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        url,
      });
      return {
        response: responseFromHttp(response),
        sensitiveValues: [...Object.values(context.secrets), ...Object.values(headers)],
      };
    } catch (error) {
      if (error instanceof DeclarativeProviderOperationError || error instanceof UnsafeRemoteUrlError || error instanceof ProviderHttpError) throw error;
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new DeclarativeProviderOperationError({ code: 'http_failed', kind: 'transient', message: 'Declarative provider HTTP request failed.', retryable: true });
    } finally {
      await response?.dispose?.();
    }
  }

  private allowedExtraFields(modelId: string): ReadonlySet<string> {
    const model = this.spec.models.find((candidate) => candidate.id === modelId) ?? this.spec.models[0];
    return new Set(Object.keys(model?.requestSchema?.properties ?? {}));
  }
}

function composeUrl(baseUrl: string | undefined, request: CompiledRequest): string {
  if (baseUrl === undefined) throw new DeclarativeCompileError('invalid_base_url', 'Provider Base URL is required.');
  const base = assertDeclarativeBaseUrl(baseUrl);
  const basePath = base.pathname.replace(/\/+$/u, '');
  const url = new URL(`${base.origin}${basePath}${request.relativePath}`);
  for (const [name, value] of Object.entries(request.query)) url.searchParams.append(name, value);
  return url.toString();
}
