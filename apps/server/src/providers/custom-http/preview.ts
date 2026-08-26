import type { GenerationRequest } from '@imagine/shared';
import type { ProviderContext } from '@imagine/provider-contract';

import {
  compileDeclarativeRequest,
  type CompiledBody,
  type CompiledRequest,
} from './compiler.js';
import {
  extractDeclarativeResponse,
  type DeclarativeExtractedResponse,
  type DeclarativeResponse,
  type DeclarativeResponsePhase,
} from './extractor.js';
import type { DeclarativeEndpoint, DeclarativeHttpSpec } from './schema.js';

export interface RedactedFilePreview {
  readonly field: string;
  readonly filename: string;
  readonly contentType: string;
  readonly assetId: string;
  readonly byteLength: number;
}

export type RedactedBodyPreview =
  | { readonly type: 'none' }
  | { readonly type: 'json'; readonly value: unknown }
  | { readonly type: 'form'; readonly fields: Readonly<Record<string, string>> }
  | {
      readonly type: 'multipart';
      readonly fields: Readonly<Record<string, string>>;
      readonly files: readonly RedactedFilePreview[];
    };

export interface RedactedRequestPreview {
  readonly method: CompiledRequest['method'];
  readonly relativePath: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: RedactedBodyPreview;
}

function redactBody(body: CompiledBody): RedactedBodyPreview {
  if (body.type === 'none') return { type: 'none' };
  if (body.type === 'json') return { type: 'json', value: body.value };
  if (body.type === 'form') return { fields: body.fields, type: 'form' };
  return {
    fields: body.fields,
    files: body.files.map((file) => ({
      assetId: file.input.assetId,
      byteLength: file.input.bytes.byteLength,
      contentType: file.contentType,
      field: file.field,
      filename: file.filename,
    })),
    type: 'multipart',
  };
}

export function redactedRequestPreview(
  spec: DeclarativeHttpSpec,
  request: GenerationRequest,
  context: ProviderContext,
  endpoint: DeclarativeEndpoint = spec.submit,
): RedactedRequestPreview {
  const compiled = compileDeclarativeRequest(spec, request, context, endpoint, { mode: 'redacted' });
  return {
    body: redactBody(compiled.body),
    headers: compiled.headers,
    method: compiled.method,
    query: compiled.query,
    relativePath: compiled.relativePath,
  };
}

export function simulatedResponse(
  endpoint: DeclarativeEndpoint,
  response: DeclarativeResponse,
  phase: DeclarativeResponsePhase,
): DeclarativeExtractedResponse {
  return extractDeclarativeResponse(endpoint, response, phase);
}

export const testResponsePath = simulatedResponse;
