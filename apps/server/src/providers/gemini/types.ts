import type {
  ProviderInput,
  ProviderContext,
  ProviderError,
} from '@imagine/provider-contract';

export type GeminiInputRole = ProviderInput['role'];

/**
 * Inputs are deliberately resolved before the adapter is called. The adapter
 * never treats an asset id as media bytes.
 */
export type GeminiInputAsset = ProviderInput;

export interface GeminiHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
  signal?: AbortSignal;
}

export interface GeminiHttpHeaders {
  get(name: string): string | null;
}

export interface GeminiHttpResponse {
  status?: number;
  statusCode?: number;
  body?: unknown;
  headers?: Readonly<Record<string, string | readonly string[] | undefined>> | GeminiHttpHeaders;
  json?: unknown | (() => Promise<unknown>);
  text?: string | (() => Promise<string>);
  dispose?: () => Promise<void> | void;
}

/**
 * The provider owns request construction, while the application owns the
 * safe/pinned HTTP implementation. No default network client is created.
 */
export interface GeminiHttpTransport {
  request(input: GeminiHttpRequest): Promise<GeminiHttpResponse>;
}

export type GeminiHttpRequestExecutor = (
  input: GeminiHttpRequest,
) => Promise<GeminiHttpResponse>;

export type GeminiProviderContext = ProviderContext & {
  headers?: Readonly<Record<string, string>>;
  http?: GeminiHttpTransport | GeminiHttpRequestExecutor;
  transport?: GeminiHttpTransport | GeminiHttpRequestExecutor;
};

export interface GeminiProviderOptions {
  http?: GeminiHttpTransport | GeminiHttpRequestExecutor;
  transport?: GeminiHttpTransport | GeminiHttpRequestExecutor;
  baseUrl?: string;
  headers?: Readonly<Record<string, string>>;
}

export interface GeminiNormalizedError extends ProviderError {
  providerStatus?: string;
}
