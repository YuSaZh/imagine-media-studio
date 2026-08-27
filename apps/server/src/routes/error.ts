import type { FastifyInstance, FastifyReply } from 'fastify';

/** Keep ordinary JSON requests bounded even when a route forgets a local limit. */
export const SERVER_BODY_LIMIT = 2 * 1024 * 1024;
export const YAML_BODY_LIMIT = 128 * 1024;

const YAML_CONTENT_TYPES = ['application/yaml', 'text/yaml', 'application/x-yaml'];

interface SafeErrorResponse {
  error: string;
  message: string;
}

function property(error: unknown, key: string): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return key in error ? (error as Record<string, unknown>)[key] : undefined;
}

function errorCode(error: unknown): string | undefined {
  const code = property(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function errorName(error: unknown): string | undefined {
  const name = property(error, 'name');
  return typeof name === 'string' ? name : undefined;
}

function sendSafeError(reply: FastifyReply, statusCode: number, response: SafeErrorResponse): void {
  reply.code(statusCode).send(response);
}

function isInvalidDocumentError(error: unknown): boolean {
  const code = errorCode(error);
  const name = errorName(error);
  return code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
    code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
    code === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH' ||
    code === 'FST_ERR_CTP_INVALID_YAML_BODY' ||
    code === 'invalid_json' ||
    code === 'invalid_yaml' ||
    name === 'YAMLParseError';
}

function isValidationError(error: unknown): boolean {
  return errorCode(error) === 'FST_ERR_VALIDATION';
}

/** Install parsers for adapter documents without making Fastify parse YAML itself. */
export function registerRawDocumentParsers(app: FastifyInstance): void {
  app.addContentTypeParser(
    YAML_CONTENT_TYPES,
    { bodyLimit: YAML_BODY_LIMIT, parseAs: 'buffer' },
    (_request, body, done) => {
      try {
        done(null, new TextDecoder('utf-8', { fatal: true }).decode(body as Uint8Array));
      } catch {
        const error = new Error('The request body is not valid UTF-8.') as Error & { code?: string };
        error.code = 'FST_ERR_CTP_INVALID_YAML_BODY';
        done(error);
      }
    },
  );
}

/** Convert parser and unexpected errors to the public, payload-free error contract. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    const code = errorCode(error);
    if (
      code === 'FST_ERR_CTP_BODY_TOO_LARGE' ||
      code === 'FST_REQ_FILE_TOO_LARGE' ||
      code === 'FST_PARTS_LIMIT' ||
      code === 'FST_FILES_LIMIT' ||
      code === 'FST_FIELDS_LIMIT'
    ) {
      sendSafeError(reply, 413, {
        error: 'request_body_too_large',
        message: 'Request body is too large.',
      });
      return;
    }
    if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      sendSafeError(reply, 415, {
        error: 'unsupported_media_type',
        message: 'The request content type is not supported.',
      });
      return;
    }
    if (isInvalidDocumentError(error)) {
      sendSafeError(reply, 400, {
        error: 'invalid_request_body',
        message: 'The request body is invalid.',
      });
      return;
    }
    if (isValidationError(error)) {
      sendSafeError(reply, 400, {
        error: 'invalid_request',
        message: 'The request does not match the internal API contract.',
      });
      return;
    }
    sendSafeError(reply, 500, {
      error: 'internal_server_error',
      message: 'The server could not complete the request.',
    });
  });
}
