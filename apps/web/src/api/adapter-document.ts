const ADAPTER_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;

function isBlankLine(line: string): boolean {
  return /^[ \t]*$/u.test(line);
}

function boundedVersion(value: string): string | undefined {
  if (!ADAPTER_VERSION_PATTERN.test(value)) return undefined;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return undefined;
  }
  return value;
}

function versionFromRootValue(value: string): string | undefined {
  if (value.startsWith("'") && value.endsWith("'")) {
    const inner = value.slice(1, -1);
    if (inner.includes("'") || inner.includes('\\')) return undefined;
    return boundedVersion(inner);
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    const inner = value.slice(1, -1);
    if (inner.includes('"') || inner.includes('\\')) return undefined;
    return boundedVersion(inner);
  }
  if (value.includes("'") || value.includes('"') || value.includes('\\')) return undefined;
  return boundedVersion(value);
}

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    const code = character.codePointAt(0) ?? 0;
    if (code === 13 && text[index + 1] === '\n') continue;
    if ((code < 32 && code !== 10) || code === 127) return true;
  }
  return false;
}

function hasForbiddenYamlToken(line: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === "'") {
      if (character === "'") {
        if (line[index + 1] === "'") {
          index += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (quote === '"') {
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (character === '"') quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    const previous = index === 0 ? undefined : line[index - 1];
    const tokenBoundary = previous === undefined || /[ \t:[\]{},]/u.test(previous);
    if (tokenBoundary && (character === '&' || character === '*' || character === '!')) return true;
    if (character === '#' && (previous === undefined || /[ \t]/u.test(previous))) return true;
  }
  return quote !== undefined;
}

function rootKeyLine(line: string): { key: string; value: string } | undefined {
  if (line.length === 0 || line[0] === ' ' || line[0] === '\t') return undefined;
  const separator = line.indexOf(':');
  if (separator <= 0) return undefined;
  const key = line.slice(0, separator);
  if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(key)) return undefined;
  const suffix = line.slice(separator + 1);
  if (suffix.length === 0) return { key, value: '' };
  if (!suffix.startsWith(' ')) return undefined;
  return { key, value: suffix.slice(1) };
}

/**
 * Reads only the deterministic YAML export envelope emitted by the server.
 * This is a root-key scanner, deliberately not a general YAML parser.
 */
export function readExportedYamlEnvelopeVersion(text: string): string | undefined {
  if (typeof text !== 'string' || hasControlCharacter(text)) return undefined;

  const lines = text.split('\n').map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
  const keys = new Map<string, string>();
  for (const line of lines) {
    if (isBlankLine(line)) continue;
    if (/^[ \t]*(?:---|\.\.\.)[ \t]*(?:#.*)?$/u.test(line)) return undefined;
    if (hasForbiddenYamlToken(line)) return undefined;
    const root = rootKeyLine(line);
    if (root === undefined) {
      if (line[0] !== ' ' && line[0] !== '\t') return undefined;
      continue;
    }
    if (keys.has(root.key)) return undefined;
    keys.set(root.key, root.value);
  }

  if (keys.size !== 3 || !keys.has('schemaVersion') || !keys.has('version') || !keys.has('definition')) return undefined;
  if (keys.get('schemaVersion') !== '1' || keys.get('definition') !== '') return undefined;
  return versionFromRootValue(keys.get('version')!);
}
