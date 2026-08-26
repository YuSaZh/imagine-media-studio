import type { GenerationRequest } from '@imagine/shared';
import type { ProviderInput } from '@imagine/provider-contract';

import {
  MAX_SPEC_STRING_LENGTH,
  MAX_TEMPLATE_TOKENS,
  isDangerousKey,
} from './schema.js';

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'host',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const AUTH_FORBIDDEN_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'cookie',
  'set-cookie',
  'content-type',
]);
const PROTECTED_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'authorization',
  'content-type',
  'cookie',
  'set-cookie',
  'api-key',
  'x-api-key',
]);
const REQUEST_FIELDS = new Set([
  'operation',
  'providerId',
  'modelId',
  'prompt',
  'negativePrompt',
  'aspectRatio',
  'width',
  'height',
  'resolution',
  'count',
  'durationSeconds',
  'fps',
  'quality',
  'format',
  'seed',
  'audio',
]);
const INPUT_FIELDS = new Set(['assetId', 'filename', 'mimeType', 'width', 'height', 'fileSize', 'sha256']);
const ROLE_PATTERN = /^(?:source|reference|mask|first_frame|last_frame)$/u;
const TOKEN_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/gu;

export type TemplateMode = 'runtime' | 'redacted';

export class DeclarativeTemplateError extends Error {
  public override readonly name = 'DeclarativeTemplateError';
  public constructor(message: string) {
    super(message);
  }
}

export interface DeclarativeTemplateContext {
  readonly request: GenerationRequest;
  readonly providerId: string;
  readonly jobId?: string;
  readonly remoteJobId?: string;
  readonly inputs?: readonly ProviderInput[];
  readonly secrets?: Readonly<Record<string, string>>;
}

export interface TemplateOptions {
  readonly mode?: TemplateMode;
  readonly allowedExtraFields?: ReadonlySet<string>;
}

type TemplateValue = string | number | boolean | null;

function assertScalar(value: unknown, token: string): TemplateValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'string' && value.length > MAX_SPEC_STRING_LENGTH) {
      throw new DeclarativeTemplateError(`Template value '${token}' is too long.`);
    }
    if (typeof value === 'string' && [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })) {
      throw new DeclarativeTemplateError(`Template value '${token}' contains control characters.`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new DeclarativeTemplateError(`Template value '${token}' is not finite.`);
    }
    return value;
  }
  throw new DeclarativeTemplateError(`Template '${token}' resolved to an unsupported value.`);
}

function inputValue(
  token: string,
  role: string,
  index: number,
  field: string,
  inputs: readonly ProviderInput[],
): TemplateValue {
  if (!ROLE_PATTERN.test(role) || !INPUT_FIELDS.has(field)) {
    throw new DeclarativeTemplateError(`Template variable '${token}' is not allowed.`);
  }
  const matches = inputs.filter((input) => input.role === role);
  const input = matches[index];
  if (input === undefined) throw new DeclarativeTemplateError(`Template input '${token}' is unavailable.`);
  if (field === 'bytes') throw new DeclarativeTemplateError('Input bytes can only be sent through a declared file part.');
  return assertScalar(input[field as keyof ProviderInput], token);
}

function requestValue(
  token: string,
  parts: readonly string[],
  request: GenerationRequest,
  allowedExtraFields: ReadonlySet<string>,
): TemplateValue {
  if (parts.length === 2 && REQUEST_FIELDS.has(parts[1]!)) {
    return assertScalar(request[parts[1]! as keyof GenerationRequest], token);
  }
  if (parts.length === 3 && parts[1] === 'extra' && allowedExtraFields.has(parts[2]!)) {
    return assertScalar(request.extra?.[parts[2]!], token);
  }
  throw new DeclarativeTemplateError(`Template variable '${token}' is not declared.`);
}

function resolveToken(
  rawToken: string,
  context: DeclarativeTemplateContext,
  options: TemplateOptions,
): TemplateValue {
  const token = rawToken.trim();
  if (!token || token.includes('(') || token.includes(')') || token.includes('[') || token.includes(']') || token.includes('|') || token.includes('=')) {
    throw new DeclarativeTemplateError(`Template expression '${token}' is not allowed.`);
  }
  const parts = token.split('.');
  if (parts.some((part, index) => part === '' || isDangerousKey(part) || !((index === 2 && parts[0] === 'input' && /^\d+$/u.test(part)) || /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(part)))) {
    throw new DeclarativeTemplateError(`Template variable '${token}' is invalid.`);
  }
  if (parts[0] === 'request') return requestValue(token, parts, context.request, options.allowedExtraFields ?? new Set());
  if (parts[0] === 'remoteJobId' && parts.length === 1) return assertScalar(context.remoteJobId, token);
  if (parts[0] === 'context' && parts.length === 2 && (parts[1] === 'providerId' || parts[1] === 'jobId')) {
    return assertScalar(parts[1] === 'providerId' ? context.providerId : context.jobId, token);
  }
  if (parts[0] === 'secret' && parts.length === 2) {
    const secret = context.secrets?.[parts[1]!];
    if (options.mode === 'redacted') return '[REDACTED]';
    return assertScalar(secret, token);
  }
  if (parts[0] === 'input' && parts.length === 4 && /^\d+$/u.test(parts[2]!) && context.inputs !== undefined) {
    return inputValue(token, parts[1]!, Number(parts[2]), parts[3]!, context.inputs);
  }
  throw new DeclarativeTemplateError(`Template variable '${token}' is not allowed.`);
}

function hasTemplateMarker(value: string): boolean {
  return value.includes('{{') || value.includes('}}');
}

export function isSecretTemplate(value: string): boolean {
  let match: RegExpExecArray | null;
  TOKEN_PATTERN.lastIndex = 0;
  while ((match = TOKEN_PATTERN.exec(value)) !== null) {
    if (match[1]!.trim().startsWith('secret.')) return true;
  }
  return false;
}

export function resolveTemplate(
  value: TemplateValue,
  context: DeclarativeTemplateContext,
  options: TemplateOptions = {},
): TemplateValue {
  if (typeof value !== 'string') return assertScalar(value, '<literal>');
  if (hasTemplateMarker(value) && !TOKEN_PATTERN.test(value)) {
    TOKEN_PATTERN.lastIndex = 0;
    throw new DeclarativeTemplateError('Template markers are unbalanced.');
  }
  TOKEN_PATTERN.lastIndex = 0;
  let count = 0;
  const whole = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/u.exec(value);
  if (whole) return resolveToken(whole[1]!, context, options);
  const result = value.replace(TOKEN_PATTERN, (_match, rawToken: string) => {
    count += 1;
    if (count > MAX_TEMPLATE_TOKENS) throw new DeclarativeTemplateError('Template contains too many variables.');
    const resolved = resolveToken(rawToken, context, options);
    if (resolved === null) throw new DeclarativeTemplateError('Null cannot be interpolated into a string.');
    return String(resolved);
  });
  TOKEN_PATTERN.lastIndex = 0;
  if (hasTemplateMarker(result) || result.length > MAX_SPEC_STRING_LENGTH) {
    throw new DeclarativeTemplateError('Resolved template is too long or contains unresolved markers.');
  }
  return result;
}

export function assertHeaderName(name: string): void {
  if (!HEADER_NAME_PATTERN.test(name) || name.length > 256 || PROTECTED_HEADERS.has(name.toLowerCase())) {
    throw new DeclarativeTemplateError(`Header '${name}' is protected or invalid.`);
  }
}

export function assertAuthenticationHeaderName(name: string): void {
  if (!HEADER_NAME_PATTERN.test(name) || name.length > 256 || AUTH_FORBIDDEN_HEADERS.has(name.toLowerCase())) {
    throw new DeclarativeTemplateError(`Authentication header '${name}' is invalid.`);
  }
}

export function assertHeaderValue(value: string): void {
  if (value.length > MAX_SPEC_STRING_LENGTH || /[\r\n]/u.test(value)) {
    throw new DeclarativeTemplateError('Header value is invalid.');
  }
}

export function isProtectedHeader(name: string): boolean {
  return PROTECTED_HEADERS.has(name.toLowerCase());
}

export function encodePathSegment(value: TemplateValue): string {
  if (value === null) throw new DeclarativeTemplateError('Null cannot be used in a path.');
  return encodeURIComponent(String(value));
}

export function scalarToString(value: TemplateValue, label: string): string {
  if (value === null) throw new DeclarativeTemplateError(`${label} cannot be null.`);
  const result = String(value);
  if (result.length > MAX_SPEC_STRING_LENGTH) throw new DeclarativeTemplateError(`${label} is too long.`);
  return result;
}
