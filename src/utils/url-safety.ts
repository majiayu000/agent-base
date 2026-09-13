import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// ============================================================================
// URL Safety (SSRF protection)
// ============================================================================

export interface UrlSafetyOptions {
  /** Allow http: in addition to https:. Default: false (https only). */
  allowHttp?: boolean;
  /** If set, hostname must be in this list (case-insensitive). */
  allowedHosts?: string[];
  /** Resolve DNS and reject private/link-local answers. Default: true. */
  resolveDns?: boolean;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google',
]);

/**
 * Throw if `urlString` is not safe for outbound HTTP from agent tools.
 * Checks scheme, hostname allow/block lists, literal IPs, and (by default) DNS resolution.
 */
export async function assertSafeHttpUrl(
  urlString: string,
  options: UrlSafetyOptions = {}
): Promise<URL> {
  const { allowHttp = false, allowedHosts, resolveDns = true } = options;

  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme === 'https:') {
    // ok
  } else if (scheme === 'http:') {
    if (!allowHttp) {
      throw new Error(`Blocked URL scheme "http:" — only https: is allowed by default`);
    }
  } else {
    throw new Error(`Blocked URL scheme "${parsed.protocol}" — only http(s) allowed`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (!hostname) {
    throw new Error('URL hostname is required');
  }

  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new Error(`Blocked hostname: ${hostname}`);
  }

  if (allowedHosts && allowedHosts.length > 0) {
    const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));
    if (!allowed.has(hostname)) {
      throw new Error(`Hostname not in allowlist: ${hostname}`);
    }
  }

  const ipVersion = isIP(hostname);
  if (ipVersion) {
    assertPublicIp(hostname, ipVersion);
    return parsed;
  }

  // Block obvious decimal / hex IP encodings that isIP misses when dotted-odd
  if (looksLikeNumericHost(hostname)) {
    throw new Error(`Blocked numeric hostname: ${hostname}`);
  }

  if (resolveDns) {
    let addresses: { address: string; family: number }[];
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch (err) {
      throw new Error(
        `Failed to resolve hostname "${hostname}": ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!addresses.length) {
      throw new Error(`No DNS records for hostname: ${hostname}`);
    }

    for (const { address, family } of addresses) {
      assertPublicIp(address, family);
    }
  }

  return parsed;
}

function looksLikeNumericHost(hostname: string): boolean {
  // Pure decimal / hex forms sometimes used to smuggle IPv4 (e.g. 2130706433, 0x7f000001)
  if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) {
    return true;
  }
  return false;
}

function assertPublicIp(ip: string, family: number): void {
  if (family === 4 || isIP(ip) === 4) {
    if (isBlockedIpv4(ip)) {
      throw new Error(`Blocked private/link-local/metadata address: ${ip}`);
    }
    return;
  }

  if (family === 6 || isIP(ip) === 6) {
    if (isBlockedIpv6(ip)) {
      throw new Error(`Blocked private/link-local/metadata address: ${ip}`);
    }
    return;
  }

  throw new Error(`Unrecognized IP address: ${ip}`);
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;

  // 0.0.0.0/8
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 169.254.0.0/16 link-local / cloud metadata
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 192.0.0.0/24, 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 documentation
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 51 || b === 18)) return true;
  if (a === 203 && b === 0) return true;
  // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved
  if (a >= 224) return true;

  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // IPv4-mapped IPv6 (:ffff:x.x.x.x)
  const mapped = normalized.match(/^:?:ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) {
    return isBlockedIpv4(mapped[1]);
  }
  const mappedHex = normalized.match(/^:?:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isBlockedIpv4(v4);
  }

  // Expand to check prefixes — use a coarse string/prefix approach via URL/net
  // ::1 loopback
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  // Unspecified
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;

  const full = expandIpv6(normalized);
  if (!full) return true;

  const first = parseInt(full[0], 16);
  // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfe80) return true;
  // fc00::/7 unique local
  if ((first & 0xfe00) === 0xfc00) return true;
  // ff00::/8 multicast
  if ((first & 0xff00) === 0xff00) return true;

  return false;
}

function expandIpv6(ip: string): string[] | null {
  const halves = ip.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    return head.map((h) => h.padStart(4, '0'));
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array(missing).fill('0'), ...tail].map((h) => h.padStart(4, '0'));
}

export interface SafeFetchOptions extends RequestInit {
  /** Max redirects to follow after re-validating each Location. Default: 5. */
  maxRedirects?: number;
  urlSafety?: UrlSafetyOptions;
}

/**
 * fetch wrapper that validates the initial URL and every redirect Location.
 */
export async function safeFetch(
  url: string,
  init: SafeFetchOptions = {}
): Promise<Response> {
  const { maxRedirects = 5, urlSafety, ...fetchInit } = init;
  let current = url;

  for (let i = 0; i <= maxRedirects; i++) {
    await assertSafeHttpUrl(current, urlSafety);

    const response = await fetch(current, {
      ...fetchInit,
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Redirect (${response.status}) without Location header`);
      }
      current = new URL(location, current).href;
      continue;
    }

    return response;
  }

  throw new Error(`Too many redirects (limit ${maxRedirects})`);
}
