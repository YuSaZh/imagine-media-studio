import { readFileSync } from 'node:fs';

import type { GenerationRequest, JsonValue } from '@imagine/shared';
import type { ProviderContext, ProviderInput } from '@imagine/provider-contract';
import { describe, expect, it } from 'vitest';

import {
  DeclarativeCompileError,
  DeclarativeHttpAdapter,
  DeclarativeResponseError,
  DeclarativeSpecError,
  compileDeclarativeRequest,
  encodeCompiledBody,
  extractCatalog,
  extractDeclarativeResponse,
  parseDeclarativeJson,
  parseDeclarativeYaml,
  readJsonPointer,
  redactedRequestPreview,
  type DeclarativeHttpClient,
  type DeclarativeHttpResponse,
} from './index.js';
import {
  ProviderHttpClient,
  type ProviderHttpExecutor,
  type ProviderHttpRawResponse,
} from '../provider-http-client.js';

const FIXTURES = new URL('../../../../../fixtures/providers/custom-http/', import.meta.url);

function readFixture(path: string): string {
  return readFileSync(new URL(path, FIXTURES), 'utf8');
}

function readJsonFixture<T>(path: string): T {
  return JSON.parse(readFixture(path)) as T;
}

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    operation: 'image.generate',
    providerId: 'custom',
    modelId: 'image-model',
    prompt: 'A red kite',
    inputs: [],
    ...overrides,
  };
}

function context(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    providerId: 'custom',
    baseUrl: 'https://api.example.test',
    secrets: { apiKey: 'custom-secret-value' },
    ...overrides,
  };
}

function fixtureResponse(input: {
  status: number;
  headers?: DeclarativeHttpResponse['headers'];
  body?: Uint8Array;
  json?: unknown;
  text?: string;
}): DeclarativeHttpResponse {
  return {
    dispose: async () => undefined,
    headers: input.headers ?? Object.create(null) as DeclarativeHttpResponse['headers'],
    status: input.status,
    statusCode: input.status,
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.json === undefined ? {} : { json: input.json }),
    ...(input.text === undefined ? {} : { text: input.text }),
  };
}

function input(assetId: string, role: ProviderInput['role'], bytes: Uint8Array): ProviderInput {
  return {
    assetId,
    bytes,
    filename: `${assetId}.png`,
    fileSize: bytes.byteLength,
    height: 1,
    mimeType: 'image/png',
    parentAssetId: role === 'mask' ? 'source-1' : null,
    role,
    sha256: '0'.repeat(64),
    width: 1,
  };
}

describe('custom declarative HTTP parser and compiler', () => {
  it('parses JSON and compiles typed templates without performing network I/O', () => {
    const spec = parseDeclarativeJson(readFixture('sync-image/adapter.json'));
    const compiled = compileDeclarativeRequest(
      spec,
      readJsonFixture<GenerationRequest>('sync-image/submit-request.json'),
      context(),
    );

    expect(compiled).toMatchObject({
      method: 'POST',
      relativePath: '/v1/images',
      headers: { Authorization: 'Bearer custom-secret-value', 'Content-Type': 'application/json' },
    });
    expect(compiled.body).toMatchObject({
      type: 'json',
      value: { model: 'image-model', prompt: 'A red kite', style: 'editorial' },
    });
    const normalized = extractDeclarativeResponse(spec.submit, {
      json: readJsonFixture('sync-image/submit-response.json'),
      status: 200,
    }, 'submit');
    expect(normalized).toEqual(readJsonFixture('sync-image/expected-normalized.json'));
    if (normalized.state !== 'completed' || normalized.assets[0]?.source !== 'base64') throw new Error('Expected a completed Base64 image fixture.');
    const png = Buffer.from(normalized.assets[0].base64, 'base64');
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it('parses the safe YAML core subset and extracts asynchronous states and URL results', () => {
    const spec = parseDeclarativeYaml(readFixture('async-video/adapter.yaml'));
    const submit = extractDeclarativeResponse(spec.submit, {
      json: readJsonFixture('async-video/submit-response.json'),
      status: 202,
    }, 'submit');
    const running = extractDeclarativeResponse(spec.poll!, {
      json: readJsonFixture('async-video/poll-running.json'),
      status: 200,
    }, 'poll');
    const completed = extractDeclarativeResponse(spec.poll!, {
      json: readJsonFixture('async-video/poll-completed.json'),
      status: 200,
    }, 'poll');

    expect(submit).toEqual({ state: 'pending', remoteJobId: 'job-1', status: 'queued' });
    expect(running).toEqual({ state: 'pending', remoteJobId: 'job-1', progress: 50, status: 'running' });
    expect(completed).toMatchObject({
      state: 'completed',
      assets: [{ source: 'url', type: 'video', mimeType: 'video/mp4', url: 'https://media.example/video.mp4' }],
    });
    expect(completed).toEqual(readJsonFixture('async-video/expected-normalized.json'));
  });

  it('compiles role-selected multipart files and keeps binary bytes out of previews', () => {
    const spec = parseDeclarativeJson(readFixture('multipart-image-edit/adapter.json'));
    const source = input('source-1', 'source', new Uint8Array([1, 2, 3]));
    const mask = input('mask-1', 'mask', new Uint8Array([4, 5]));
    const compiled = compileDeclarativeRequest(
      spec,
      readJsonFixture<GenerationRequest>('multipart-image-edit/submit-request.json'),
      context({ inputs: [source, mask] }),
    );
    const encoded = encodeCompiledBody(compiled.body);
    const preview = redactedRequestPreview(
      spec,
      readJsonFixture<GenerationRequest>('multipart-image-edit/submit-request.json'),
      context({ inputs: [source, mask] }),
    );

    expect(compiled.body).toMatchObject({ type: 'multipart', files: [{ field: 'image' }, { field: 'mask' }] });
    expect(encoded.bodyBytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(encoded.bodyBytes ?? []).includes(Buffer.from([1, 2, 3]))).toBe(true);
    expect(preview.headers.Authorization).toBe('[REDACTED]');
    expect(JSON.stringify(preview)).not.toContain('1,2,3');
    expect(preview.body).toMatchObject({ type: 'multipart' });
    expect((preview.body as { files: readonly { assetId: string; byteLength: number }[] }).files.map((file) => ({ assetId: file.assetId, byteLength: file.byteLength }))).toEqual([
      { assetId: 'source-1', byteLength: 3 },
      { assetId: 'mask-1', byteLength: 2 },
    ]);
    const normalized = extractDeclarativeResponse(spec.submit, {
      json: readJsonFixture('multipart-image-edit/submit-response.json'),
      status: 200,
    }, 'submit');
    expect(normalized).toEqual(readJsonFixture('multipart-image-edit/expected-normalized.json'));
  });

  it('enforces the model request schema and rejects secret query templates', () => {
    const spec = parseDeclarativeJson(readFixture('sync-image/adapter.json'));
    expect(() => compileDeclarativeRequest(spec, request({ extra: { unknown: true } }), context())).toThrow(DeclarativeCompileError);
    const querySpec = parseDeclarativeJson(readFixture('sync-image/adapter.json'));
    querySpec.submit.query = { token: '{{ secret.apiKey }}' };
    expect(() => compileDeclarativeRequest(querySpec, request({ extra: { style: 'editorial' } }), context())).toThrow(/Secrets may not be placed in query/);
    querySpec.submit.query = { 'api-key': 'value' };
    expect(() => compileDeclarativeRequest(querySpec, request({ extra: { style: 'editorial' } }), context())).toThrow(/Credential-like query/);
    for (const name of ['access-token', 'access.token', 'oauth_token', 'oauth.token', 'x_amz_signature', 'x.amz.signature', 'x-goog-signature', 'x-ms-credential', 'api.key']) {
      querySpec.submit.query = { [name]: 'value' };
      expect(() => compileDeclarativeRequest(querySpec, request({ extra: { style: 'editorial' } }), context())).toThrow(/Credential-like query/);
    }
    for (const name of ['tokenizer', 'authenticity', 'keynote', 'signatured', 'client_secretary']) {
      querySpec.submit.query = { [name]: 'value' };
      expect(() => compileDeclarativeRequest(querySpec, request({ extra: { style: 'editorial' } }), context())).not.toThrow();
    }
  });

  it('rejects duplicate/prototype/alias/tag/merge documents and malformed paths', () => {
    expect(() => parseDeclarativeJson('{"schemaVersion":1,"schemaVersion":1}')).toThrow(DeclarativeSpecError);
    expect(() => parseDeclarativeJson('{"__proto__":{}}')).toThrow(DeclarativeSpecError);
    expect(() => parseDeclarativeJson(readFixture('sync-image/adapter.json').replace('"schemaVersion": 1,', '"unknown": true,"schemaVersion": 1,'))).toThrow(DeclarativeSpecError);
    expect(() => parseDeclarativeYaml('schemaVersion: 1\nvalue: &anchor x\n')).toThrow(DeclarativeSpecError);
    expect(() => parseDeclarativeYaml('schemaVersion: 1\nvalue: !secret x\n')).toThrow(DeclarativeSpecError);
    expect(() => parseDeclarativeYaml('schemaVersion: 1\nvalue: *anchor\n')).toThrow(DeclarativeSpecError);
    expect(() => parseDeclarativeYaml('schemaVersion: 1\n<<: {x: y}\n')).toThrow(DeclarativeSpecError);
    expect(() => parseDeclarativeYaml('schemaVersion: 1\nvalue: x\nvalue: y\n')).toThrow(DeclarativeSpecError);
    const spec = parseDeclarativeJson(readFixture('sync-image/adapter.json'));
    spec.submit.path = '/v1/../images';
    expect(() => compileDeclarativeRequest(spec, request({ extra: { style: 'x' } }), context())).toThrow(/dot traversal/);
  });

  it('rejects unreachable operations, cancel mismatches, and sync/async ambiguity at import', () => {
    const asyncText = readFixture('async-video/adapter.yaml');
    expect(() => parseDeclarativeYaml(asyncText.replace('supportsCancel: false', 'supportsCancel: true'))).toThrow(DeclarativeSpecError);
    expect(() => parseDeclarativeJson(readFixture('sync-image/adapter.json').replace('"supportsBatchCount": false', '"supportsBatchCount": true'))).toThrow(DeclarativeSpecError);
    expect(() => parseDeclarativeJson(readFixture('sync-image/adapter.json').replace('"resultBase64Path":', '"remoteIdPath":"/id","resultBase64Path":'))).toThrow(DeclarativeSpecError);
    expect(() => parseDeclarativeJson(readFixture('sync-image/adapter.json').replace('"image.generate"', '"video.edit"'))).toThrow(DeclarativeSpecError);
  });

  it('keeps a single-result declarative model from claiming batch output', () => {
    const spec = parseDeclarativeJson(readFixture('sync-image/adapter.json'));
    spec.models[0]!.capabilities.supportsBatchCount = true;
    spec.models[0]!.capabilities.maxBatchCount = 2;
    expect(() => compileDeclarativeRequest(spec, request({ count: 2, extra: { style: 'editorial' } }), context())).toThrow(/batch/);
  });

  it('rejects CRLF/protected headers, unresolved expressions, and non-canonical bodies', () => {
    const spec = parseDeclarativeJson(readFixture('sync-image/adapter.json'));
    spec.submit.headers = { 'X-Trace': 'ok\r\nInjected: yes' };
    expect(() => compileDeclarativeRequest(spec, request({ extra: { style: 'x' } }), context())).toThrow(DeclarativeCompileError);
    spec.submit.headers = { Authorization: 'override' };
    expect(() => compileDeclarativeRequest(spec, request({ extra: { style: 'x' } }), context())).toThrow(DeclarativeCompileError);
    spec.submit.headers = { 'X-Trace': '{{ request.prompt.toString() }}' };
    expect(() => compileDeclarativeRequest(spec, request({ extra: { style: 'x' } }), context())).toThrow(DeclarativeCompileError);
  });

  it('validates operation options and loaded image relationships before compiling', () => {
    const spec = parseDeclarativeJson(readFixture('multipart-image-edit/adapter.json'));
    spec.models[0]!.capabilities.inputImageConstraints = {
      maxBytes: 3,
      maxHeight: 1,
      maxPixels: 1,
      maxWidth: 1,
      mimeTypes: ['image/png'],
    };
    const editRequest = readJsonFixture<GenerationRequest>('multipart-image-edit/submit-request.json');
    const source = input('source-1', 'source', new Uint8Array([1, 2, 3]));
    const mask = input('mask-1', 'mask', new Uint8Array([4, 5]));
    expect(() => compileDeclarativeRequest(spec, editRequest, context({ inputs: [source, mask] }))).not.toThrow();
    expect(() => compileDeclarativeRequest(spec, editRequest, context({ inputs: [{ ...source, width: 2 }, mask] }))).toThrow(/width limit/);
    expect(() => compileDeclarativeRequest(spec, editRequest, context({ inputs: [{ ...source, mimeType: 'text/plain' }, mask] }))).toThrow(/image/);
    expect(() => compileDeclarativeRequest(spec, { ...editRequest, modelId: 'missing-model' }, context({ inputs: [source, mask] }))).toThrow(/not declared/);
    spec.models[0]!.capabilities.resolutions = ['512x512'];
    expect(() => compileDeclarativeRequest(spec, { ...editRequest, width: 1024, height: 1024 }, context({ inputs: [source, mask] }))).toThrow(/dimensions/);
    expect(() => compileDeclarativeRequest(spec, { ...editRequest, durationSeconds: 4 }, context({ inputs: [source, mask] }))).toThrow(/duration support/);
  });

  it('uses random multipart boundaries and rejects deterministic collisions', () => {
    const spec = parseDeclarativeJson(readFixture('multipart-image-edit/adapter.json'));
    const editRequest = readJsonFixture<GenerationRequest>('multipart-image-edit/submit-request.json');
    const source = input('source-1', 'source', new Uint8Array([1, 2, 3]));
    const mask = input('mask-1', 'mask', new Uint8Array([4, 5]));
    const compiled = compileDeclarativeRequest(spec, editRequest, context({ inputs: [source, mask] }));
    const encoded = encodeCompiledBody(compiled.body, () => 'fixed-boundary');
    expect(encoded.contentType).toContain('boundary=fixed-boundary');
    const collision = compileDeclarativeRequest(spec, editRequest, context({ inputs: [{ ...source, bytes: new TextEncoder().encode('fixed-boundary'), fileSize: 14 }, mask] }));
    expect(() => encodeCompiledBody(collision.body, () => 'fixed-boundary')).toThrow(/collides/);
  });

  it('rejects malformed pointers, unknown statuses, invalid expiry, and unsafe catalog responses', () => {
    expect(() => readJsonPointer({}, '/bad~2pointer')).toThrow(DeclarativeResponseError);
    const spec = parseDeclarativeYaml(readFixture('async-video/adapter.yaml'));
    expect(() => extractDeclarativeResponse(spec.poll!, { status: 200, json: { id: 'job-1', status: 'mystery' } }, 'poll')).toThrow(/unknown or ambiguous status/);
    expect(() => extractDeclarativeResponse(spec.poll!, { status: 200, json: { id: 'other-job', status: 'running', progress: 50 } }, 'poll', [], 'job-1')).toThrow(/remote job ID/);
    const noResponseId = { ...spec.poll!, extract: { ...spec.poll!.extract, remoteIdPath: undefined, resultIdPath: undefined } };
    expect(extractDeclarativeResponse(noResponseId, { status: 200, json: { status: 'running', progress: 50 } }, 'poll', [], 'job-1')).toMatchObject({ state: 'pending', remoteJobId: 'job-1' });
    spec.poll!.extract.resultExpiresAtPath = '/expires_at';
    const completed = extractDeclarativeResponse(spec.poll!, { status: 200, json: { id: 'job-1', status: 'completed', expires_at: '2030-01-01T00:00:00.000Z', video: { url: 'https://media.example/video.mp4' } } }, 'poll');
    expect(completed).toMatchObject({ resultExpiresAt: new Date('2030-01-01T00:00:00.000Z') });
    expect(() => extractDeclarativeResponse(spec.poll!, { status: 200, json: { id: 'job-1', status: 'completed', expires_at: 'not-a-date', video: { url: 'https://media.example/video.mp4' } } }, 'poll')).toThrow(/expiry/);
    const catalog = { ...spec.submit, method: 'GET' as const, path: '/models', body: undefined, extract: { modelsPath: '/data', modelIdPath: '/id', modelNamePath: '/name' } };
    expect(() => extractCatalog(catalog, { status: 503, json: {} })).toThrow(DeclarativeResponseError);
  });

  it('normalizes a submit-only remote id without a status field as pending', () => {
    const spec = parseDeclarativeJson(readFixture('sync-image/adapter.json'));
    spec.submit.extract.resultBase64Path = undefined;
    spec.submit.extract.remoteIdPath = '/id';
    expect(extractDeclarativeResponse(spec.submit, { status: 200, json: { id: 'job-only' } }, 'submit')).toEqual({ state: 'pending', remoteJobId: 'job-only' });
    const ambiguous = parseDeclarativeJson(readFixture('sync-image/adapter.json'));
    ambiguous.submit.extract.remoteIdPath = '/id';
    expect(() => extractDeclarativeResponse(ambiguous.submit, { status: 200, json: { id: 'job-only', data: [{ b64_json: 'aGVsbG8=' }] } }, 'submit')).toThrow(/both remote job ID and completed result/);
  });

  it('redacts provider error text and exposes only declared optional methods', () => {
    const spec = parseDeclarativeYaml(readFixture('async-video/adapter.yaml'));
    const error = extractDeclarativeResponse(spec.submit, { status: 400, json: { error: { message: 'X-API-Key=custom-secret-value', code: 'secret-code' } } }, 'submit', ['custom-secret-value']);
    expect(JSON.stringify(error)).not.toContain('custom-secret-value');
    const credentialError = extractDeclarativeResponse(spec.submit, { status: 400, json: { error: { message: 'authorization: Bearer leaked credential=hidden idempotency-key=idem' } } }, 'submit');
    expect(JSON.stringify(credentialError)).not.toContain('leaked');
    expect(JSON.stringify(credentialError)).not.toContain('hidden');
    const sync = new DeclarativeHttpAdapter(parseDeclarativeJson(readFixture('sync-image/adapter.json')));
    expect(sync.poll).toBeUndefined();
    expect(sync.cancel).toBeUndefined();
    const asyncAdapter = new DeclarativeHttpAdapter(spec);
    expect(asyncAdapter.poll).toBeTypeOf('function');
    expect(asyncAdapter.cancel).toBeUndefined();
  });

  it('redacts long secrets across the public error boundary and bounds oversized errors', () => {
    const spec = parseDeclarativeYaml(readFixture('async-video/adapter.yaml'));
    const longSecret = 's'.repeat(16 * 1024);
    const crossed = `prefix-${'x'.repeat(500)}${longSecret}-suffix`;
    const result = extractDeclarativeResponse(spec.submit, { status: 400, json: { error: { message: crossed } } }, 'submit', [longSecret]);
    expect(result).toMatchObject({ state: 'failed', error: { message: expect.any(String) } });
    if (result.state !== 'failed') throw new Error('Expected a normalized error.');
    expect(result.error.message.length).toBeLessThanOrEqual(512);
    expect(result.error.message).not.toContain(longSecret.slice(0, 64));
    const oversized = extractDeclarativeResponse(spec.submit, { status: 400, json: { error: { message: 'a'.repeat(1_000_000) } } }, 'submit');
    expect(oversized).toMatchObject({ state: 'failed', error: { message: expect.any(String) } });
    if (oversized.state !== 'failed') throw new Error('Expected a bounded oversized error.');
    expect(oversized.error.message.length).toBeLessThanOrEqual(512);
  });

  it('uses the cancel phase for an optional 204 endpoint and requests the custom response limit', async () => {
    const base = parseDeclarativeYaml(readFixture('async-video/adapter.yaml'));
    const spec = {
      ...base,
      cancel: {
        method: 'POST' as const,
        path: '/v1/videos/{{ remoteJobId }}/cancel',
        responseType: 'json' as const,
        expectedStatus: [204],
        extract: {},
      },
      models: base.models.map((model) => ({ ...model, capabilities: { ...model.capabilities, supportsCancel: true } })),
    };
    const requests: Array<{ url: string; maxResponseBodyBytes: number }> = [];
    const adapter = new DeclarativeHttpAdapter(spec, {
      http: {
        async request(input) {
          requests.push({ maxResponseBodyBytes: input.maxResponseBodyBytes ?? 0, url: input.url });
          return fixtureResponse({ status: 204 });
        },
      },
    });
    await adapter.cancel!('job-1', context({ modelId: 'video-model' }));
    expect(requests).toEqual([{ maxResponseBodyBytes: 2 * 1024 * 1024, url: 'https://api.example.test/v1/videos/job-1/cancel' }]);
  });

  it('compiles non-submit endpoints without revalidating required generation inputs', async () => {
    const base = parseDeclarativeJson(readFixture('multipart-image-edit/adapter.json'));
    const spec = {
      ...base,
      connection: {
        method: 'GET' as const,
        path: '/health',
        responseType: 'json' as const,
        expectedStatus: [200],
        extract: {},
      },
      poll: {
        method: 'GET' as const,
        path: '/jobs/{{ remoteJobId }}',
        responseType: 'json' as const,
        expectedStatus: [200],
        extract: { statusPath: '/status', successValues: ['completed'], resultBase64Path: '/data', resultMimeType: 'image/png', resultType: 'image' as const },
      },
    };
    const httpResponses: DeclarativeHttpResponse[] = [
      fixtureResponse({ status: 200, json: {} }),
      fixtureResponse({ status: 200, json: { status: 'completed', data: 'aGVsbG8=' } }),
    ];
    const adapter = new DeclarativeHttpAdapter(spec, { http: { async request() { return httpResponses.shift()!; } } });
    await expect(adapter.testConnection!(context())).resolves.toBeUndefined();
    await expect(adapter.poll!('job-1', context({ modelId: 'edit-model' }))).resolves.toMatchObject({ state: 'completed' });
  });

  it('filters live catalog models against the declarative static allowlist', async () => {
    const base = parseDeclarativeYaml(readFixture('async-video/adapter.yaml'));
    const spec = {
      ...base,
      catalog: {
        method: 'GET' as const,
        path: '/v1/models',
        responseType: 'json' as const,
        expectedStatus: [200],
        extract: { modelsPath: '/data', modelIdPath: '/id', modelNamePath: '/name' },
      },
    };
    const adapter = new DeclarativeHttpAdapter(spec, {
      http: {
        async request() {
          return fixtureResponse({ status: 200, json: { data: [{ id: 'video-model', name: 'Known' }, { id: 'unknown-video', name: 'Unknown' }] } });
        },
      },
    });
    await expect(adapter.getLiveCapabilities(context())).resolves.toMatchObject({ models: [{ id: 'video-model', displayName: 'Video Model' }] });
  });
});

describe('custom declarative HTTP response extraction', () => {
  it('supports RFC 6901 escaping and rejects ambiguous or invalid result data', () => {
    expect(readJsonPointer({ 'a/b': { '~x': 4 } }, '/a~1b/~0x')).toBe(4);
    const spec = parseDeclarativeJson(readFixture('sync-image/adapter.json'));
    spec.submit.extract.resultUrlPath = '/data/0/url';
    expect(() => extractDeclarativeResponse(spec.submit, { status: 200, json: { data: [{ b64_json: 'aGVsbG8=', url: 'https://x.test/a.png' }] } }, 'submit')).toThrow(DeclarativeResponseError);
    spec.submit.extract.resultBase64Path = undefined;
    expect(() => extractDeclarativeResponse(spec.submit, { status: 200, json: { data: [{ url: 'https://x.test/a.png?token=secret' }] } }, 'submit')).toThrow(DeclarativeResponseError);
    expect(() => extractDeclarativeResponse(spec.submit, { status: 200, json: { data: [{ url: 'https://x.test/a.png' }] } }, 'submit')).not.toThrow();
    spec.submit.extract.resultMimeType = 'image/svg+xml';
    expect(() => extractDeclarativeResponse(spec.submit, { status: 200, json: { data: [{ url: 'https://x.test/a.png' }] } }, 'submit')).toThrow(DeclarativeResponseError);
  });

  it('keeps HTTP status and maps bounded error responses without echoing bodies', () => {
    const spec = parseDeclarativeYaml(readFixture('async-video/adapter.yaml'));
    const result = extractDeclarativeResponse(spec.submit, {
      headers: { 'retry-after': '7' },
      status: 429,
      text: 'not-json and should not be returned',
    }, 'submit');
    expect(result).toEqual({
      state: 'failed',
      error: expect.objectContaining({ kind: 'transient', retryable: true, statusCode: 429, retryAfterMs: 7_000 }),
    });
    expect(JSON.stringify(result)).not.toContain('not-json');
  });

  it('enforces progress, MIME, URL credential, Base64 and response depth limits', () => {
    const spec = parseDeclarativeYaml(readFixture('async-video/adapter.yaml'));
    expect(() => extractDeclarativeResponse(spec.poll!, { status: 200, json: { id: 'job-1', status: 'running', progress: '50' } }, 'poll')).toThrow(DeclarativeResponseError);
    expect(() => extractDeclarativeResponse(spec.poll!, { status: 200, json: { id: 'job-1', status: 'completed', video: { url: 'https://x.test/video.mp4?token=secret' } } }, 'poll')).toThrow(DeclarativeResponseError);
    const image = parseDeclarativeJson(readFixture('sync-image/adapter.json'));
    expect(() => extractDeclarativeResponse(image.submit, { status: 200, json: { data: [{ id: 'x', b64_json: 'not-base64' }] } }, 'submit')).toThrow(DeclarativeResponseError);
    const largerBase64 = Buffer.alloc(5_000, 1).toString('base64');
    expect(extractDeclarativeResponse(image.submit, { status: 200, json: { data: [{ b64_json: largerBase64 }] } }, 'submit')).toMatchObject({ state: 'completed', assets: [{ source: 'base64' }] });
    const deep: Record<string, JsonValue> = {};
    let current = deep;
    for (let index = 0; index < 20; index += 1) {
      const next: Record<string, JsonValue> = {};
      current.next = next;
      current = next;
    }
    expect(() => extractDeclarativeResponse(image.submit, { status: 200, json: { data: [{ b64_json: 'aGVsbG8=' }], deep } }, 'submit')).toThrow(DeclarativeResponseError);
  });
});

describe('DeclarativeHttpAdapter', () => {
  it('uses requestSchema as the authoritative schema and keeps only metadata from explicit custom fields', async () => {
    const spec = parseDeclarativeJson(readFixture('sync-image/adapter.json'));
    const requestSchema = {
      additionalProperties: false,
      properties: {
        style: { enum: ['editorial'], maxLength: 32, type: 'string' },
        vendorRequired: { type: 'boolean' },
      },
      required: ['style'],
      type: 'object',
    } as const;
    spec.models[0]!.requestSchema = requestSchema;
    spec.models[0]!.capabilities.customFields = {
      additionalProperties: true,
      properties: {
        style: { enum: ['editorial', 'portrait'], type: 'string' },
        vendorFlag: { type: 'boolean' },
      },
      required: [],
      type: 'object',
      description: 'The API key is configured separately from model fields.',
      labels: ['Editorial', 'Portrait'],
      modelFields: { style: { description: 'Visual treatment.' } },
    };
    const adapter = new DeclarativeHttpAdapter(spec);
    const capabilities = await adapter.getCapabilities(context());
    expect(capabilities.models[0]?.capabilities.customFields).toEqual({
      additionalProperties: false,
      properties: {
        style: { enum: ['editorial'], maxLength: 32, type: 'string' },
        vendorRequired: { type: 'boolean' },
      },
      required: ['style'],
      type: 'object',
      description: 'The API key is configured separately from model fields.',
      labels: ['Editorial', 'Portrait'],
      modelFields: { style: { description: 'Visual treatment.' } },
    });

    const accepted = request({ extra: { style: 'editorial', vendorRequired: true } });
    await expect(adapter.validate(accepted, context())).resolves.toBeUndefined();
    const submitAdapter = new DeclarativeHttpAdapter(spec, {
      http: {
        async request() {
          return fixtureResponse({ status: 200, json: readJsonFixture('sync-image/submit-response.json') });
        },
      },
    });
    await expect(submitAdapter.submit(accepted, context())).resolves.toMatchObject({ state: 'completed' });
    await expect(adapter.validate(request({ extra: { style: 'portrait', vendorRequired: true } }), context()))
      .rejects.toThrow(/outside the enum/);
    await expect(adapter.validate(request({ extra: { vendorRequired: true } }), context()))
      .rejects.toThrow(/Missing request parameter 'style'/);
    await expect(adapter.validate(request({ extra: { style: 'editorial', vendorFlag: true } }), context()))
      .rejects.toThrow(/Unknown request parameter/);
  });

  it('rejects credential values and secret templates in metadata while preserving descriptive metadata', async () => {
    const unsafeMetadata = [
      { apiKey: 'static-secret' },
      { client_secret: 'static-secret' },
      { Authorization: 'Bearer static-secret' },
      { ui: { template: '{{ secret.apiKey }}' } },
    ];
    for (const customFields of unsafeMetadata) {
      const spec = parseDeclarativeJson(readFixture('sync-image/adapter.json'));
      spec.models[0]!.capabilities.customFields = customFields;
      await expect(new DeclarativeHttpAdapter(spec).getCapabilities(context())).rejects.toThrow(/credential/i);
    }

    const spec = parseDeclarativeJson(readFixture('sync-image/adapter.json'));
    spec.models[0]!.capabilities.customFields = {
      description: 'The API key is configured separately.',
      labels: ['Authorization', 'safe label'],
      modelFields: { style: { description: 'A model field.' } },
    };
    await expect(new DeclarativeHttpAdapter(spec).getCapabilities(context())).resolves.toMatchObject({
      models: [{ capabilities: { customFields: spec.models[0]!.capabilities.customFields } }],
    });
  });

  it('does not invent customFields when a model has no requestSchema', async () => {
    const spec = parseDeclarativeJson(readFixture('multipart-image-edit/adapter.json'));
    const capabilities = await new DeclarativeHttpAdapter(spec).getCapabilities(context());
    expect(capabilities.models[0]?.capabilities.customFields).toBeUndefined();
  });

  it('does not treat an incomplete schema-shaped customFields object as requestable metadata', async () => {
    const spec = parseDeclarativeJson(readFixture('sync-image/adapter.json'));
    spec.models[0]!.requestSchema = undefined;
    spec.models[0]!.capabilities.customFields = {
      properties: { quality: { type: 'string' } },
      type: 'object',
    };
    const adapter = new DeclarativeHttpAdapter(spec, {
      http: {
        async request() {
          throw new Error('submit must fail validation before HTTP');
        },
      },
    });
    const capabilities = await adapter.getCapabilities(context());
    expect(capabilities.models[0]?.capabilities.customFields).toBeUndefined();
    await expect(adapter.validate(request({ extra: { quality: 'high' } }), context()))
      .rejects.toThrow(/does not declare extra request parameters/);
    await expect(adapter.submit(request({ extra: { quality: 'high' } }), context()))
      .rejects.toThrow(/does not declare extra request parameters/);
  });

  it('does not ignore unknown schema keys or discard only invalid legacy properties', async () => {
    const credentialSpec = parseDeclarativeJson(readFixture('sync-image/adapter.json'));
    credentialSpec.models[0]!.requestSchema = undefined;
    credentialSpec.models[0]!.capabilities.customFields = {
      apiKey: { foo: 'LEAK', type: 'string' },
    };
    await expect(new DeclarativeHttpAdapter(credentialSpec).getCapabilities(context()))
      .rejects.toThrow(/credential/i);

    const invalidFallbackSpec = parseDeclarativeJson(readFixture('sync-image/adapter.json'));
    invalidFallbackSpec.models[0]!.requestSchema = undefined;
    invalidFallbackSpec.models[0]!.capabilities.customFields = {
      additionalProperties: false,
      properties: {
        style: { type: 'string', ui: { unknown: 'extension' } },
      },
      type: 'object',
    };
    const invalidFallbackAdapter = new DeclarativeHttpAdapter(invalidFallbackSpec);
    expect((await invalidFallbackAdapter.getCapabilities(context())).models[0]?.capabilities.customFields).toBeUndefined();
    await expect(invalidFallbackAdapter.validate(request({ extra: { style: 'editorial' } }), context()))
      .rejects.toThrow(/does not declare extra request parameters/);
  });

  it('uses a complete restricted customFields schema as the legacy validation fallback', async () => {
    const spec = parseDeclarativeJson(readFixture('sync-image/adapter.json'));
    spec.models[0]!.requestSchema = undefined;
    spec.models[0]!.capabilities.customFields = {
      additionalProperties: false,
      properties: { style: { enum: ['editorial'], type: 'string' } },
      type: 'object',
    };
    const adapter = new DeclarativeHttpAdapter(spec, {
      http: {
        async request() {
          return fixtureResponse({ status: 200, json: readJsonFixture('sync-image/submit-response.json') });
        },
      },
    });
    expect((await adapter.getCapabilities(context())).models[0]?.capabilities.customFields).toEqual({
      additionalProperties: false,
      properties: { style: { enum: ['editorial'], type: 'string' } },
      type: 'object',
    });
    await expect(adapter.submit(request({ extra: { style: 'editorial' } }), context()))
      .resolves.toMatchObject({ state: 'completed' });
    await expect(adapter.validate(request({ extra: { style: 'editorial', unknown: true } }), context()))
      .rejects.toThrow(/Unknown request parameter/);
  });

  class FixtureHttp implements DeclarativeHttpClient {
    public readonly requests: Array<{ url: string; body?: string; bodyBytes?: Uint8Array }> = [];
    public constructor(private readonly responses: readonly DeclarativeHttpResponse[]) {}

    public async request(input: Parameters<DeclarativeHttpClient['request']>[0]): Promise<DeclarativeHttpResponse> {
      this.requests.push({
        url: input.url,
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.bodyBytes === undefined ? {} : { bodyBytes: input.bodyBytes }),
      });
      const response = this.responses[this.requests.length - 1];
      if (response === undefined) throw new Error('Unexpected fixture request.');
      return response;
    }
  }

  it('uses only the injected client for submit and poll and normalizes failures safely', async () => {
    const spec = parseDeclarativeYaml(readFixture('async-video/adapter.yaml'));
    const http = new FixtureHttp([
      fixtureResponse({ status: 202, json: readJsonFixture('async-video/submit-response.json') }),
      fixtureResponse({ status: 200, json: readJsonFixture('async-video/poll-completed.json') }),
    ]);
    const adapter = new DeclarativeHttpAdapter(spec, { http });
    const videoRequest: GenerationRequest = {
      ...readJsonFixture<GenerationRequest>('async-video/submit-request.json'),
      providerId: 'custom',
    };
    const submit = await adapter.submit(videoRequest, context({ modelId: 'video-model' }));
    const poll = await adapter.poll!('job-1', context({ modelId: 'video-model' }));

    expect(submit).toEqual({ state: 'pending', remoteJobId: 'job-1' });
    expect(poll).toMatchObject({ state: 'completed', assets: [{ type: 'video' }] });
    expect(http.requests.map((item) => item.url)).toEqual([
      'https://api.example.test/v1/videos',
      'https://api.example.test/v1/videos/job-1',
    ]);
    expect(adapter.normalizeError(new Error('secret from remote'))).toEqual({
      code: 'provider_unknown',
      kind: 'unknown',
      message: 'Declarative provider request failed.',
      retryable: false,
    });
  });

  it('consumes the shared ProviderHttpClient port without performing real network I/O', async () => {
    let disposed = false;
    const executor: ProviderHttpExecutor = async (_target, input) => {
      expect(input.method).toBe('POST');
      expect(input.url).toBe('https://api.example.test/v1/images');
      const response: ProviderHttpRawResponse = {
        body: readFixture('sync-image/submit-response.json'),
        dispose: () => {
          disposed = true;
        },
        headers: { 'content-type': 'application/json' },
        statusCode: 200,
      };
      return response;
    };
    const http = new ProviderHttpClient({
      executor,
      resolver: async () => [{ address: '8.8.8.8', family: 4 }],
    });
    const adapter = new DeclarativeHttpAdapter(parseDeclarativeJson(readFixture('sync-image/adapter.json')));

    await expect(adapter.submit(request({ extra: { style: 'editorial' } }), context({ http }))).resolves.toMatchObject({
      state: 'completed',
      assets: [{ mimeType: 'image/png', source: 'base64', type: 'image' }],
    });
    expect(disposed).toBe(true);
  });
});
