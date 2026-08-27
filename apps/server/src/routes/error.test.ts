import Fastify from 'fastify';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import {
  registerErrorHandler,
  registerRawDocumentParsers,
  SERVER_BODY_LIMIT,
  YAML_BODY_LIMIT,
} from './error.js';

describe('HTTP error boundary and document parsers', () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function createApp() {
    const app = Fastify({ bodyLimit: SERVER_BODY_LIMIT, logger: false });
    registerRawDocumentParsers(app);
    registerErrorHandler(app);
    apps.push(app);
    app.post('/echo', async (request) => ({ body: request.body }));
    app.post('/parse-yaml', async (request) => parseYaml(request.body as string));
    app.get('/throw', async () => {
      throw new Error('private implementation detail');
    });
    return app;
  }

  it('keeps YAML MIME bodies as bounded UTF-8 strings', async () => {
    const app = createApp();
    const body = 'name: 你好\n';

    for (const contentType of ['application/yaml', 'text/yaml', 'application/x-yaml']) {
      const response = await app.inject({
        method: 'POST',
        url: '/echo',
        headers: { 'content-type': contentType },
        payload: body,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ body });
    }
  });

  it('maps body limits and parser failures to safe ErrorResponses', async () => {
    const app = createApp();
    const yamlTooLarge = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/yaml' },
      payload: Buffer.alloc(YAML_BODY_LIMIT + 1, 0x20),
    });
    const jsonTooLarge = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: Buffer.alloc(SERVER_BODY_LIMIT + 1, 0x20),
    });
    const invalidJson = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    const invalidYaml = await app.inject({
      method: 'POST',
      url: '/parse-yaml',
      headers: { 'content-type': 'application/yaml' },
      payload: 'items: [',
    });
    const invalidUtf8Yaml = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/yaml' },
      payload: Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x3a, 0x20, 0xc3, 0x28, 0x0a]),
    });

    expect(yamlTooLarge.statusCode).toBe(413);
    expect(jsonTooLarge.statusCode).toBe(413);
    expect(invalidJson.statusCode).toBe(400);
    expect(invalidYaml.statusCode).toBe(400);
    expect(invalidUtf8Yaml.statusCode).toBe(400);
    for (const response of [yamlTooLarge, jsonTooLarge, invalidJson, invalidYaml, invalidUtf8Yaml]) {
      const payload = response.json<Record<string, unknown>>();
      expect(payload).toMatchObject({ error: expect.any(String), message: expect.any(String) });
      expect(payload).not.toHaveProperty('stack');
      expect(payload).not.toHaveProperty('cause');
      expect(payload).not.toHaveProperty('body');
    }
  });

  it('maps unsupported media types and unknown failures without leaking details', async () => {
    const app = createApp();
    const unsupported = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('binary'),
    });
    const unknown = await app.inject({ method: 'GET', url: '/throw' });

    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json()).toEqual({
      error: 'unsupported_media_type',
      message: 'The request content type is not supported.',
    });
    expect(unknown.statusCode).toBe(500);
    expect(unknown.json()).toEqual({
      error: 'internal_server_error',
      message: 'The server could not complete the request.',
    });
    expect(unknown.body).not.toContain('private implementation detail');
    expect(unknown.body).not.toContain('stack');
    expect(unknown.body).not.toContain('cause');
  });
});
