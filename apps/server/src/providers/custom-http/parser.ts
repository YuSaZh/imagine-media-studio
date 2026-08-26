import { Buffer } from 'node:buffer';

import { isAlias, isMap, isScalar, isSeq, parseDocument as parseYamlDocument } from 'yaml';

import {
  DeclarativeHttpSpecSchema,
  MAX_SPEC_ARRAY_ITEMS,
  MAX_SPEC_BYTES,
  MAX_SPEC_DEPTH,
  MAX_SPEC_KEYS,
  MAX_SPEC_NODES,
  MAX_SPEC_STRING_LENGTH,
  isDangerousKey,
  type DeclarativeHttpSpec,
} from './schema.js';

export type DeclarativeDocumentFormat = 'json' | 'yaml';

export class DeclarativeSpecError extends Error {
  public override readonly name = 'DeclarativeSpecError';

  public constructor(
    public readonly code:
      | 'input_too_large'
      | 'invalid_json'
      | 'invalid_yaml'
      | 'unsafe_document'
      | 'schema_invalid',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface ParseLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxKeys: number;
  readonly maxArrayItems: number;
  readonly maxStringLength: number;
  readonly maxTotalStringLength: number;
}

interface ParseState {
  readonly limits: ParseLimits;
  nodes: number;
  keys: number;
  arrays: number;
  strings: number;
}

const SPEC_LIMITS: ParseLimits = {
  maxArrayItems: MAX_SPEC_ARRAY_ITEMS,
  maxDepth: MAX_SPEC_DEPTH,
  maxKeys: MAX_SPEC_KEYS,
  maxNodes: MAX_SPEC_NODES,
  maxStringLength: MAX_SPEC_STRING_LENGTH,
  maxTotalStringLength: MAX_SPEC_NODES * MAX_SPEC_STRING_LENGTH,
};

function createState(limits: ParseLimits = SPEC_LIMITS): ParseState {
  return { arrays: 0, keys: 0, limits, nodes: 0, strings: 0 };
}

function countNode(current: ParseState, depth: number): void {
  current.nodes += 1;
  if (current.nodes > current.limits.maxNodes) throw new DeclarativeSpecError('unsafe_document', 'Declarative document contains too many nodes.');
  if (depth > current.limits.maxDepth) throw new DeclarativeSpecError('unsafe_document', 'Declarative document is too deeply nested.');
}

function countString(current: ParseState, value: string): void {
  current.strings += value.length;
  if (value.length > current.limits.maxStringLength || current.strings > current.limits.maxTotalStringLength) {
    throw new DeclarativeSpecError('unsafe_document', 'Declarative document contains oversized strings.');
  }
}

function countKey(current: ParseState, key: string): void {
  if (isDangerousKey(key) || key.length === 0 || key.length > current.limits.maxStringLength) {
    throw new DeclarativeSpecError('unsafe_document', 'Declarative document key is invalid.');
  }
  current.keys += 1;
  if (current.keys > current.limits.maxKeys) throw new DeclarativeSpecError('unsafe_document', 'Declarative document has too many keys.');
  countString(current, key);
}

/** Re-checks parser output using the same bounded JSON-tree rules for JSON and YAML. */
export function assertBoundedJsonTree(value: unknown, limits: ParseLimits = SPEC_LIMITS): void {
  const state = createState(limits);
  const walk = (node: unknown, depth: number, seen: Set<object>): void => {
    countNode(state, depth);
    if (node === null || typeof node === 'boolean') return;
    if (typeof node === 'string') {
      countString(state, node);
      return;
    }
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw new DeclarativeSpecError('unsafe_document', 'Declarative document numbers must be finite.');
      return;
    }
    if (typeof node !== 'object') throw new DeclarativeSpecError('unsafe_document', 'Declarative document contains a non-JSON value.');
    if (seen.has(node)) throw new DeclarativeSpecError('unsafe_document', 'Declarative document contains a cycle.');
    seen.add(node);
    if (Array.isArray(node)) {
      state.arrays += 1;
      if (node.length > limits.maxArrayItems || state.arrays > limits.maxArrayItems) throw new DeclarativeSpecError('unsafe_document', 'Declarative document contains an oversized array.');
      for (const child of node) walk(child, depth + 1, seen);
    } else {
      const prototype = Object.getPrototypeOf(node);
      if (prototype !== null && prototype !== Object.prototype) throw new DeclarativeSpecError('unsafe_document', 'Declarative document object is not plain.');
      const entries = Object.entries(node as Record<string, unknown>);
      for (const [key, child] of entries) {
        countKey(state, key);
        walk(child, depth + 1, seen);
      }
    }
    seen.delete(node);
  };
  walk(value, 0, new Set<object>());
}

class JsonReader {
  private readonly current: ParseState;
  private index = 0;

  public constructor(private readonly input: string, limits: ParseLimits = SPEC_LIMITS) {
    this.current = createState(limits);
  }

  public read(): unknown {
    this.skipWhitespace();
    const value = this.value(0);
    this.skipWhitespace();
    if (this.index !== this.input.length) this.fail('Trailing JSON content is not allowed.');
    return value;
  }

  private value(depth: number): unknown {
    this.skipWhitespace();
    countNode(this.current, depth);
    const character = this.input[this.index];
    if (character === '{') return this.object(depth + 1);
    if (character === '[') return this.array(depth + 1);
    if (character === '"') return this.string();
    if (character === 't' && this.consume('true')) return true;
    if (character === 'f' && this.consume('false')) return false;
    if (character === 'n' && this.consume('null')) return null;
    if (character === '-' || (character !== undefined && /[0-9]/u.test(character))) return this.number();
    this.fail('JSON value is invalid.');
  }

  private object(depth: number): Readonly<Record<string, unknown>> {
    this.index += 1;
    const result = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.input[this.index] === '}') {
      this.index += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.input[this.index] !== '"') this.fail('JSON object keys must be strings.');
      const key = this.string();
      if (keys.has(key)) this.fail('Duplicate JSON object keys are not allowed.');
      keys.add(key);
      countKey(this.current, key);
      this.skipWhitespace();
      if (this.input[this.index] !== ':') this.fail('JSON object key must be followed by a colon.');
      this.index += 1;
      result[key] = this.value(depth);
      this.skipWhitespace();
      if (this.input[this.index] === '}') {
        this.index += 1;
        return result;
      }
      if (this.input[this.index] !== ',') this.fail('JSON object members must be comma separated.');
      this.index += 1;
    }
  }

  private array(depth: number): readonly unknown[] {
    this.index += 1;
    const result: unknown[] = [];
    this.current.arrays += 1;
    if (this.current.arrays > this.current.limits.maxArrayItems) this.fail('JSON contains too many arrays.');
    this.skipWhitespace();
    if (this.input[this.index] === ']') {
      this.index += 1;
      return result;
    }
    for (;;) {
      if (result.length >= this.current.limits.maxArrayItems) this.fail('JSON array is too large.');
      result.push(this.value(depth));
      this.skipWhitespace();
      if (this.input[this.index] === ']') {
        this.index += 1;
        return result;
      }
      if (this.input[this.index] !== ',') this.fail('JSON array values must be comma separated.');
      this.index += 1;
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    for (;;) {
      const character = this.input[this.index];
      if (character === undefined) this.fail('JSON string is unterminated.');
      if (!escaped && character === '"') {
        this.index += 1;
        let value: unknown;
        try {
          value = JSON.parse(this.input.slice(start, this.index)) as unknown;
        } catch {
          this.fail('JSON string is invalid.');
        }
        if (typeof value !== 'string') this.fail('JSON string is invalid.');
        countString(this.current, value);
        return value;
      }
      if (!escaped && character < ' ') this.fail('JSON strings cannot contain control characters.');
      if (escaped) {
        if (character === 'u') {
          const hex = this.input.slice(this.index + 1, this.index + 5);
          if (!/^[0-9A-Fa-f]{4}$/u.test(hex)) this.fail('JSON unicode escape is invalid.');
          this.index += 4;
        }
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      }
      this.index += 1;
    }
  }

  private number(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(this.input.slice(this.index));
    if (!match) this.fail('JSON number is invalid.');
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail('JSON number must be finite.');
    this.index += match[0].length;
    return value;
  }

  private consume(value: string): boolean {
    if (this.input.slice(this.index, this.index + value.length) !== value) return false;
    this.index += value.length;
    return true;
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.input[this.index] ?? '')) this.index += 1;
  }

  private fail(message: string): never {
    throw new DeclarativeSpecError('invalid_json', `${message} (offset ${this.index}).`);
  }
}

export function parseBoundedJsonDocument(input: string, limits?: ParseLimits): unknown {
  return new JsonReader(input, limits).read();
}

function yamlNodeToJson(node: unknown, current: ParseState, depth: number, seen = new Set<object>()): unknown {
  countNode(current, depth);
  if (node === null || node === undefined) return null;
  if (isAlias(node)) throw new DeclarativeSpecError('unsafe_document', 'YAML aliases are not allowed.');
  if (typeof node === 'object' && seen.has(node)) throw new DeclarativeSpecError('unsafe_document', 'YAML document contains a cycle.');
  const candidate = node as { tag?: unknown; value?: unknown; items?: readonly unknown[] };
  if (candidate.tag !== undefined) throw new DeclarativeSpecError('unsafe_document', 'YAML tags and custom types are not allowed.');
  if (isScalar(node)) {
    const value = candidate.value;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      countString(current, value);
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    throw new DeclarativeSpecError('unsafe_document', 'YAML scalar is not a JSON value.');
  }
  if (typeof node !== 'object') throw new DeclarativeSpecError('unsafe_document', 'YAML node is invalid.');
  seen.add(node);
  if (isSeq(node)) {
    const items = candidate.items ?? [];
    current.arrays += 1;
    if (items.length > current.limits.maxArrayItems || current.arrays > current.limits.maxArrayItems) throw new DeclarativeSpecError('unsafe_document', 'YAML sequence is too large.');
    const result = items.map((item) => yamlNodeToJson(item, current, depth + 1, seen));
    seen.delete(node);
    return result;
  }
  if (isMap(node)) {
    const result = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    for (const pair of candidate.items ?? []) {
      const entry = pair as { key?: unknown; value?: unknown };
      const key = yamlNodeToJson(entry.key, current, depth + 1, seen);
      if (typeof key !== 'string') throw new DeclarativeSpecError('invalid_yaml', 'YAML mapping keys must be strings.');
      if (keys.has(key)) throw new DeclarativeSpecError('invalid_yaml', `Duplicate YAML key '${key}' is not allowed.`);
      keys.add(key);
      countKey(current, key);
      result[key] = yamlNodeToJson(entry.value, current, depth + 1, seen);
    }
    seen.delete(node);
    return result;
  }
  throw new DeclarativeSpecError('unsafe_document', 'YAML node type is not allowed.');
}

function boundedInput(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.byteLength;
  if (bytes > MAX_SPEC_BYTES) throw new DeclarativeSpecError('input_too_large', 'Declarative specification exceeds the size limit.');
  try {
    const text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
    if (Buffer.byteLength(text, 'utf8') !== bytes) throw new Error('invalid UTF-8');
    return text;
  } catch {
    throw new DeclarativeSpecError('unsafe_document', 'Declarative specification must be valid UTF-8.');
  }
}

function parseDocument(text: string, format: DeclarativeDocumentFormat): unknown {
  if (format === 'json') {
    const parsed = parseBoundedJsonDocument(text);
    assertBoundedJsonTree(parsed);
    return parsed;
  }
  let document;
  try {
    const options: Parameters<typeof parseYamlDocument>[1] = {
      merge: false,
      prettyErrors: false,
      resolveKnownTags: false,
      schema: 'core',
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      version: '1.2',
    };
    document = parseYamlDocument(text, options);
  } catch (error) {
    throw new DeclarativeSpecError('invalid_yaml', 'Declarative YAML is invalid.', { cause: error });
  }
  if (document.errors.length > 0) throw new DeclarativeSpecError('invalid_yaml', 'Declarative YAML is invalid.');
  if (document.warnings.length > 0) throw new DeclarativeSpecError('unsafe_document', 'Declarative YAML contains unsupported tags or directives.');
  const directiveTags = Object.keys(document.directives.tags ?? {});
  if (document.directives.docStart !== null || document.directives.docEnd === true || document.directives.yaml?.explicit === true || directiveTags.some((tag) => tag !== '!!')) {
    throw new DeclarativeSpecError('unsafe_document', 'YAML directives are not allowed.');
  }
  const parsed = yamlNodeToJson(document.contents, createState(), 0);
  assertBoundedJsonTree(parsed);
  return parsed;
}

export function parseDeclarativeSpec(input: string | Uint8Array, format: DeclarativeDocumentFormat): DeclarativeHttpSpec {
  const text = boundedInput(input);
  const parsed = parseDocument(text, format);
  assertBoundedJsonTree(parsed);
  const result = DeclarativeHttpSpecSchema.safeParse(parsed);
  if (!result.success) throw new DeclarativeSpecError('schema_invalid', 'Declarative specification does not match schema.', { cause: result.error });
  return result.data;
}

export function parseDeclarativeJson(input: string | Uint8Array): DeclarativeHttpSpec {
  return parseDeclarativeSpec(input, 'json');
}

export function parseDeclarativeYaml(input: string | Uint8Array): DeclarativeHttpSpec {
  return parseDeclarativeSpec(input, 'yaml');
}

export function canonicalDeclarativeSpec(spec: DeclarativeHttpSpec): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(value as Record<string, unknown>).sort()) result[key] = stable((value as Record<string, unknown>)[key]);
      return result;
    }
    return value;
  };
  const output = JSON.stringify(stable(spec));
  if (Buffer.byteLength(output, 'utf8') > MAX_SPEC_BYTES) throw new DeclarativeSpecError('input_too_large', 'Declarative specification exceeds the size limit.');
  return output;
}
