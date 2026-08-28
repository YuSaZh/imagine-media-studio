import { lookup } from 'node:dns/promises';

import ipaddr from 'ipaddr.js';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface DnsResolverOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly connectTimeoutMs?: number;
}

/**
 * A resolver may ignore the second argument for compatibility with the
 * original hostname-only resolver shape. The policy still races every lookup
 * against its own signal and timeout when a resolver cannot cancel itself.
 */
export type DnsResolver = (
  hostname: string,
  options?: DnsResolverOptions,
) => Promise<readonly ResolvedAddress[]>;

export class UnsafeRemoteUrlError extends Error {
  public override readonly name = 'UnsafeRemoteUrlError';

  public constructor(
    message: string,
    public readonly code: 'unsafe_remote_url' | 'dns_timeout' | 'dns_aborted' | 'dns_failed' = 'unsafe_remote_url',
  ) {
    super(message);
  }
}

export interface NetworkPolicyOptions {
  allowInsecureHttp?: boolean;
  allowLoopback?: boolean;
  allowPrivateNetwork?: boolean;
  allowedHosts?: readonly string[];
  /** Effective TCP ports. Omitted means no additional port restriction. */
  allowedPorts?: readonly number[];
  /** Default timeout used for DNS resolution when a caller does not provide one. */
  dnsTimeoutMs?: number;
  /** Alias for callers that configure the network connect timeout directly. */
  connectTimeoutMs?: number;
  resolver?: DnsResolver;
}

export interface NetworkPolicyValidationOptions {
  readonly signal?: AbortSignal;
  /** Alias accepted for callers that name this a DNS timeout. */
  readonly timeoutMs?: number;
  readonly connectTimeoutMs?: number;
}

export interface ValidatedRemoteTarget {
  addresses: readonly ResolvedAddress[];
  hostname: string;
  pinnedAddress: ResolvedAddress;
  url: URL;
}

const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.aws.internal',
  'metadata.google.internal',
  'metadata.azure.internal',
]);

// These cloud metadata endpoints remain forbidden even when a deployment
// explicitly opts into private or loopback network access. ipaddr.js
// canonicalizes IPv4-mapped IPv6 values to their IPv4 form, so the shared
// IPv4 endpoint is covered in both literal representations.
const METADATA_ADDRESSES = new Set([
  '169.254.169.254',
  'fd00:ec2::254',
  'fd20:ce::254',
]);

// Keep this matcher deliberately boundary based. For example, `tokenizer`,
// `authenticity`, and `keynote` are ordinary names, while token/key segments
// separated by any URL-safe punctuation remain credential-like.
const CREDENTIAL_QUERY_TOKEN_PATTERN = /(?:^|[-_.])(?:token|key|api[-_.]?key|access[-_.]?token|auth|authorization|credential|credentials|signature|sig|secret|password|cookie|idempotency[-_.]?key|bearer)(?=$|[-_.])/iu;
const CREDENTIAL_QUERY_PREFIX_PATTERN = /^x[-_.]?(?:amz|goog|ms)(?:[-_.].+)?$/iu;
const OAUTH_QUERY_PREFIX_PATTERN = /^oauth(?:[-_.].*)?$/iu;

/** Shared credential-like query-name policy for every URL boundary. */
export function isCredentialLikeQueryName(name: string): boolean {
  const normalized = name.trim();
  return CREDENTIAL_QUERY_TOKEN_PATTERN.test(normalized)
    || CREDENTIAL_QUERY_PREFIX_PATTERN.test(normalized)
    || OAUTH_QUERY_PREFIX_PATTERN.test(normalized);
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function normalizeHostname(hostname: string): string {
  return stripIpv6Brackets(hostname).replace(/\.$/, '').toLowerCase();
}

async function defaultResolver(hostname: string): Promise<readonly ResolvedAddress[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => {
    if (result.family !== 4 && result.family !== 6) {
      throw new UnsafeRemoteUrlError('Remote hostname resolved to an unsupported address family.');
    }
    return { address: result.address, family: result.family };
  });
}

function positiveTimeout(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return resolved;
}

function effectivePort(url: URL): number {
  if (url.port !== '') return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return value !== null
    && typeof value === 'object'
    && 'aborted' in value
    && 'addEventListener' in value
    && typeof value.addEventListener === 'function';
}

function validationSignal(options: NetworkPolicyValidationOptions | AbortSignal | undefined): AbortSignal | undefined {
  return isAbortSignal(options) ? options : options?.signal;
}

function validationTimeout(
  options: NetworkPolicyValidationOptions | AbortSignal | undefined,
  fallback: number,
): number {
  if (isAbortSignal(options) || options === undefined) return fallback;
  return positiveTimeout(options.connectTimeoutMs ?? options.timeoutMs, fallback, 'DNS timeout');
}

function dnsAbortError(): UnsafeRemoteUrlError {
  return new UnsafeRemoteUrlError('Remote hostname lookup was aborted.', 'dns_aborted');
}

function dnsTimeoutError(): UnsafeRemoteUrlError {
  return new UnsafeRemoteUrlError('Remote hostname lookup timed out.', 'dns_timeout');
}

function isTimeoutLike(error: unknown): boolean {
  if (error instanceof Error) return /timeout|timed.?out/i.test(error.name) || /timeout|timed.?out/i.test(error.message);
  return false;
}

async function boundedLookup(
  resolver: DnsResolver,
  hostname: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<readonly ResolvedAddress[]> {
  if (signal?.aborted) throw dnsAbortError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let onAbort: (() => void) | undefined;
  const resolverOptions: DnsResolverOptions = {
    connectTimeoutMs: timeoutMs,
    timeoutMs,
    ...(signal === undefined ? {} : { signal }),
  };
  const lookup = Promise.resolve().then(() => {
    if (signal?.aborted) throw dnsAbortError();
    return resolver(hostname, resolverOptions);
  });
  try {
    return await new Promise<readonly ResolvedAddress[]>((resolve, reject) => {
      onAbort = () => {
        if (settled) return;
        settled = true;
        reject(dnsAbortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(dnsTimeoutError());
      }, timeoutMs);
      lookup.then(
        (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          reject(isTimeoutLike(error) ? dnsTimeoutError() : new UnsafeRemoteUrlError('Remote hostname lookup failed.', 'dns_failed'));
        },
      );
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    // Attach a rejection handler even when the race settled first. This is
    // intentionally not awaited: an uncooperative resolver may never settle.
    void lookup.catch(() => undefined);
  }
}

interface AddressClassification {
  canonical: string;
  range: string;
}

function classifyAddress(address: string): AddressClassification {
  try {
    const parsed = ipaddr.process(stripIpv6Brackets(address));
    return {
      canonical: parsed.toString().toLowerCase(),
      range: parsed.range(),
    };
  } catch {
    throw new UnsafeRemoteUrlError('Remote hostname resolved to an invalid IP address.');
  }
}

export class NetworkPolicy {
  private readonly allowInsecureHttp: boolean;
  private readonly allowLoopback: boolean;
  private readonly allowPrivateNetwork: boolean;
  private readonly allowedHosts: ReadonlySet<string> | null;
  private readonly allowedPorts: ReadonlySet<number> | null;
  private readonly dnsTimeoutMs: number;
  private readonly resolver: DnsResolver;

  public constructor(options: NetworkPolicyOptions = {}) {
    this.allowInsecureHttp = options.allowInsecureHttp ?? false;
    this.allowLoopback = options.allowLoopback ?? false;
    this.allowPrivateNetwork = options.allowPrivateNetwork ?? false;
    this.allowedHosts = options.allowedHosts
      ? new Set(options.allowedHosts.map(normalizeHostname))
      : null;
    if (options.allowedPorts !== undefined) {
      if (options.allowedPorts.length === 0 || options.allowedPorts.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535)) {
        throw new RangeError('allowedPorts must contain at least one valid TCP port.');
      }
      this.allowedPorts = new Set(options.allowedPorts);
    } else {
      this.allowedPorts = null;
    }
    this.dnsTimeoutMs = positiveTimeout(options.dnsTimeoutMs ?? options.connectTimeoutMs, 10_000, 'dnsTimeoutMs');
    this.resolver = options.resolver ?? defaultResolver;
  }

  public async validate(
    rawUrl: string | URL,
    options?: NetworkPolicyValidationOptions | AbortSignal,
    legacyConnectTimeoutMs?: number,
  ): Promise<ValidatedRemoteTarget> {
    let url: URL;
    try {
      url = rawUrl instanceof URL ? new URL(rawUrl) : new URL(rawUrl);
    } catch {
      throw new UnsafeRemoteUrlError('Remote media URL is invalid.');
    }

    if (url.username || url.password) {
      throw new UnsafeRemoteUrlError('Remote media URL cannot contain credentials.');
    }
    for (const name of url.searchParams.keys()) {
      if (isCredentialLikeQueryName(name)) {
        throw new UnsafeRemoteUrlError('Remote media URL contains credential-like query data.');
      }
    }
    if (url.protocol !== 'https:' && !(this.allowInsecureHttp && url.protocol === 'http:')) {
      throw new UnsafeRemoteUrlError('Remote media URL must use HTTPS.');
    }
    const port = effectivePort(url);
    if (this.allowedPorts !== null && !this.allowedPorts.has(port)) {
      throw new UnsafeRemoteUrlError('Remote URL port is outside the configured allowlist.');
    }
    const hostname = normalizeHostname(url.hostname);
    if (!hostname || METADATA_HOSTS.has(hostname) || hostname.endsWith('.local')) {
      throw new UnsafeRemoteUrlError('Remote hostname is not allowed.');
    }
    if (this.allowedHosts !== null && !this.allowedHosts.has(hostname)) {
      throw new UnsafeRemoteUrlError('Remote hostname is outside the configured allowlist.');
    }

    const literal = ipaddr.isValid(hostname);
    const addresses = literal
      ? [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv4' ? 4 : 6 } as const]
      : await boundedLookup(
        this.resolver,
        hostname,
        validationSignal(options),
        legacyConnectTimeoutMs === undefined
          ? validationTimeout(options, this.dnsTimeoutMs)
          : positiveTimeout(legacyConnectTimeoutMs, this.dnsTimeoutMs, 'DNS timeout'),
      );
    if (validationSignal(options)?.aborted) throw dnsAbortError();
    if (!Array.isArray(addresses) || addresses.some((address) =>
      address === null
      || typeof address !== 'object'
      || typeof address.address !== 'string'
      || (address.family !== 4 && address.family !== 6))) {
      throw new UnsafeRemoteUrlError('Remote hostname lookup failed.', 'dns_failed');
    }
    if (addresses.length === 0) {
      throw new UnsafeRemoteUrlError('Remote hostname did not resolve to an IP address.');
    }

    for (const address of addresses) {
      const classification = classifyAddress(address.address);
      if (METADATA_ADDRESSES.has(classification.canonical)) {
        throw new UnsafeRemoteUrlError('Remote address is reserved for cloud metadata.');
      }
      const range = classification.range;
      if (range === 'unicast') continue;
      if (range === 'loopback' && this.allowLoopback) continue;
      if ((range === 'private' || range === 'uniqueLocal') && this.allowPrivateNetwork) continue;
      throw new UnsafeRemoteUrlError(`Remote address range '${range}' is not allowed.`);
    }

    return {
      addresses,
      hostname,
      pinnedAddress: addresses.find((address) => address.family === 4) ?? addresses[0]!,
      url,
    };
  }
}
