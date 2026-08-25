import { lookup } from 'node:dns/promises';

import ipaddr from 'ipaddr.js';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type DnsResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export class UnsafeRemoteUrlError extends Error {
  public override readonly name = 'UnsafeRemoteUrlError';
}

export interface NetworkPolicyOptions {
  allowInsecureHttp?: boolean;
  allowLoopback?: boolean;
  allowPrivateNetwork?: boolean;
  allowedHosts?: readonly string[];
  resolver?: DnsResolver;
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

function classifyAddress(address: string): string {
  try {
    return ipaddr.process(stripIpv6Brackets(address)).range();
  } catch {
    throw new UnsafeRemoteUrlError('Remote hostname resolved to an invalid IP address.');
  }
}

export class NetworkPolicy {
  private readonly allowInsecureHttp: boolean;
  private readonly allowLoopback: boolean;
  private readonly allowPrivateNetwork: boolean;
  private readonly allowedHosts: ReadonlySet<string> | null;
  private readonly resolver: DnsResolver;

  public constructor(options: NetworkPolicyOptions = {}) {
    this.allowInsecureHttp = options.allowInsecureHttp ?? false;
    this.allowLoopback = options.allowLoopback ?? false;
    this.allowPrivateNetwork = options.allowPrivateNetwork ?? false;
    this.allowedHosts = options.allowedHosts
      ? new Set(options.allowedHosts.map(normalizeHostname))
      : null;
    this.resolver = options.resolver ?? defaultResolver;
  }

  public async validate(rawUrl: string | URL): Promise<ValidatedRemoteTarget> {
    let url: URL;
    try {
      url = rawUrl instanceof URL ? new URL(rawUrl) : new URL(rawUrl);
    } catch {
      throw new UnsafeRemoteUrlError('Remote media URL is invalid.');
    }

    if (url.username || url.password) {
      throw new UnsafeRemoteUrlError('Remote media URL cannot contain credentials.');
    }
    if (url.protocol !== 'https:' && !(this.allowInsecureHttp && url.protocol === 'http:')) {
      throw new UnsafeRemoteUrlError('Remote media URL must use HTTPS.');
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
      : await this.resolver(hostname);
    if (addresses.length === 0) {
      throw new UnsafeRemoteUrlError('Remote hostname did not resolve to an IP address.');
    }

    for (const address of addresses) {
      const range = classifyAddress(address.address);
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
