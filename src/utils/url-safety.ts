import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { IncomingMessage } from 'node:http';

// ============================================================================
// URL Safety (SSRF protection)
// ============================================================================

export interface UrlSafetyOptions {
  /** Allow http: in addition to https:. Default: false (https only). */
  allowHttp?: boolean;
  /** If set, hostname must be in this list (case-insensitive). Empty array rejects all hosts. */
  allowedHosts?: string[];
  /** Resolve DNS and reject private/link-local answers. Default: true. */
  resolveDns?: boolean;
  /** Optional abort signal used to cancel DNS validation. */
  signal?: AbortSignal;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google',
]);

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
/** Statuses that must not carry a body in the Web Response constructor. */
const NULL_BODY_STATUS = new Set([204, 205, 304]);
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'cookie2',
]);

/** Logical request URL for responses produced by safeFetch (WeakMap so Response.url stays transport-native). */
const logicalResponseUrls = new WeakMap<Response, string>();

/**
 * Return the logical final URL tracked by safeFetch, falling back to Response.url / fallback.
 */
export function getSafeFetchUrl(response: Response, fallback = ''): string {
  return logicalResponseUrls.get(response) ?? (response.url || fallback);
}

function stampLogicalUrl(response: Response, logicalUrl: string): Response {
  logicalResponseUrls.set(response, logicalUrl);
  return response;
}

export interface ValidatedSafeUrl {
  url: URL;
  /** Addresses that passed safety checks; used to pin the connection. */
  addresses: { address: string; family: number }[];
}

/**
 * Throw if `urlString` is not safe for outbound HTTP from agent tools.
 * Checks scheme, hostname allow/block lists, literal IPs, and (by default) DNS resolution.
 */
export async function assertSafeHttpUrl(
  urlString: string,
  options: UrlSafetyOptions = {}
): Promise<URL> {
  const validated = await validateSafeHttpUrl(urlString, options);
  return validated.url;
}

/**
 * Validate a URL and return the parsed URL plus public addresses suitable for connection pinning.
 */
export async function validateSafeHttpUrl(
  urlString: string,
  options: UrlSafetyOptions = {}
): Promise<ValidatedSafeUrl> {
  const { allowHttp = false, allowedHosts, resolveDns = true, signal } = options;

  if (signal?.aborted) {
    throw abortError(signal.reason);
  }

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

  // Distinguish undefined (no allowlist) from [] (fail-closed: reject all hosts).
  if (allowedHosts !== undefined) {
    const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));
    if (!allowed.has(hostname)) {
      throw new Error(`Hostname not in allowlist: ${hostname}`);
    }
  }

  const ipVersion = isIP(hostname);
  if (ipVersion) {
    assertPublicIp(hostname, ipVersion);
    return { url: parsed, addresses: [{ address: hostname, family: ipVersion }] };
  }

  // Block obvious decimal / hex IP encodings that isIP misses when dotted-odd
  if (looksLikeNumericHost(hostname)) {
    throw new Error(`Blocked numeric hostname: ${hostname}`);
  }

  if (!resolveDns) {
    return { url: parsed, addresses: [] };
  }

  const addresses = await lookupAll(hostname, signal);
  if (!addresses.length) {
    throw new Error(`No DNS records for hostname: ${hostname}`);
  }

  for (const { address, family } of addresses) {
    assertPublicIp(address, family);
  }

  return { url: parsed, addresses };
}

async function lookupAll(
  hostname: string,
  signal?: AbortSignal
): Promise<{ address: string; family: number }[]> {
  if (signal?.aborted) {
    throw abortError(signal.reason);
  }

  const lookupPromise = lookup(hostname, { all: true, verbatim: true }).catch((err) => {
    throw new Error(
      `Failed to resolve hostname "${hostname}": ${err instanceof Error ? err.message : String(err)}`
    );
  });

  if (!signal) {
    return lookupPromise;
  }

  return Promise.race([
    lookupPromise,
    new Promise<never>((_, reject) => {
      const onAbort = () => reject(abortError(signal.reason));
      signal.addEventListener('abort', onAbort, { once: true });
      // Clean up the abort listener without leaving finally()'s derived rejection unhandled
      // when lookupPromise itself rejects (Promise.race already surfaces that rejection).
      void lookupPromise.then(
        () => signal.removeEventListener('abort', onAbort),
        () => signal.removeEventListener('abort', onAbort)
      );
    }),
  ]);
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error(reason ? String(reason) : 'This operation was aborted');
  err.name = 'AbortError';
  return err;
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
  const [a, b, c] = parts;

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
  // 192.0.0.0/24 IETF protocol assignments / special-purpose
  if (a === 192 && b === 0 && c === 0) return true;
  // 192.0.2.0/24 TEST-NET-1 documentation
  if (a === 192 && b === 0 && c === 2) return true;
  // 198.18.0.0/15 benchmarking
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24 TEST-NET-2 documentation
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113.0/24 TEST-NET-3 documentation
  if (a === 203 && b === 0 && c === 113) return true;
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
  const second = parseInt(full[1], 16);
  // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfe80) return true;
  // fec0::/10 site-local (deprecated, still routed on some private networks)
  if ((first & 0xffc0) === 0xfec0) return true;
  // fc00::/7 unique local
  if ((first & 0xfe00) === 0xfc00) return true;
  // ff00::/8 multicast
  if ((first & 0xff00) === 0xff00) return true;
  // 100::/64 discard-only (RFC 6666)
  if (
    first === 0x0100 &&
    second === 0 &&
    parseInt(full[2], 16) === 0 &&
    parseInt(full[3], 16) === 0
  ) {
    return true;
  }
  // 2001:db8::/32 documentation
  if (first === 0x2001 && second === 0x0db8) return true;
  // 2001:2::/48 benchmarking
  if (first === 0x2001 && second === 0x0002 && parseInt(full[2], 16) === 0) return true;

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

/**
 * SafeFetch options. `integrity` is omitted from the public type because the Node
 * pinned transport does not implement Subresource Integrity; Bun still accepts it
 * via native fetch when callers cast, but SafeFetchOptions does not advertise it.
 */
export interface SafeFetchOptions extends Omit<RequestInit, 'integrity' | 'redirect'> {
  /** Max redirects to follow after re-validating each Location. Default: 5. */
  maxRedirects?: number;
  urlSafety?: UrlSafetyOptions;
}

/**
 * fetch wrapper that validates the initial URL and every redirect Location,
 * pins the TCP connection to a validated address, and applies Fetch redirect semantics.
 */
export async function safeFetch(
  url: string,
  init: SafeFetchOptions = {}
): Promise<Response> {
  const { maxRedirects = 5, urlSafety, ...fetchInit } = init;
  assertAllowedFetchMethod(normalizeMethod(fetchInit.method));
  let current = url;
  let requestInit: RequestInit = { ...fetchInit };

  for (let i = 0; i <= maxRedirects; i++) {
    const validated = await validateSafeHttpUrl(current, {
      ...urlSafety,
      signal: requestInit.signal ?? urlSafety?.signal,
    });

    const response = stampLogicalUrl(await pinnedFetch(validated, requestInit), current);

    if (!REDIRECT_STATUS.has(response.status)) {
      return response;
    }

    const location = response.headers.get('location');
    // Cancel unused redirect body so sockets are not held open.
    await cancelResponseBody(response);

    if (!location) {
      throw new Error(`Redirect (${response.status}) without Location header`);
    }

    const nextUrl = new URL(location, current);
    const crossOrigin = !sameOrigin(current, nextUrl.href);
    requestInit = nextRedirectInit(requestInit, response.status, crossOrigin);
    current = nextUrl.href;
  }

  throw new Error(`Too many redirects (limit ${maxRedirects})`);
}

function sameOrigin(a: string, b: string): boolean {
  const left = new URL(a);
  const right = new URL(b);
  return (
    left.protocol === right.protocol &&
    left.hostname.toLowerCase() === right.hostname.toLowerCase() &&
    left.port === right.port
  );
}

function nextRedirectInit(
  init: RequestInit,
  status: number,
  crossOrigin: boolean
): RequestInit {
  const headers = new Headers(init.headers);
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;

  // Fetch semantics:
  // - 303: convert any non-GET/HEAD method to GET and drop body
  // - 301/302: only POST is converted to GET (other methods are preserved)
  const convertToGet =
    status === 303
      ? method !== 'GET' && method !== 'HEAD'
      : (status === 301 || status === 302) && method === 'POST';
  if (convertToGet) {
    method = 'GET';
    body = undefined;
    headers.delete('content-length');
    headers.delete('content-type');
  }

  if (crossOrigin) {
    for (const name of SENSITIVE_HEADERS) {
      headers.delete(name);
    }
  }

  return {
    ...init,
    method,
    body,
    headers,
  };
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  await response.body.cancel().catch(() => undefined);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '');
}

/**
 * Serialize RequestInit body forms for the Node http(s) transport.
 * Uses Request to normalize URLSearchParams/FormData/Blob/ArrayBuffer/views.
 */
async function serializeNodeBody(
  body: BodyInit | null | undefined,
  headers: Headers
): Promise<string | Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' || Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }

  // Request normalizes FormData / Blob / URLSearchParams / ReadableStream.
  // Node requires duplex:'half' when the body is a ReadableStream.
  const streamBody =
    typeof ReadableStream !== 'undefined' && body instanceof ReadableStream;
  const tmp = new Request('http://local.invalid', {
    method: 'POST',
    body,
    ...(streamBody ? ({ duplex: 'half' } as RequestInit) : {}),
  });
  const contentType = tmp.headers.get('content-type');
  if (contentType && !headers.has('content-type')) {
    headers.set('content-type', contentType);
  }
  return Buffer.from(await tmp.arrayBuffer());
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'TRACE']);
const FORBIDDEN_FETCH_METHODS = new Set(['CONNECT', 'TRACE']);

function normalizeMethod(method: string | undefined): string {
  return (method ?? 'GET').toUpperCase();
}

function assertAllowedFetchMethod(method: string): void {
  if (FORBIDDEN_FETCH_METHODS.has(method)) {
    throw new TypeError(`'${method}' HTTP method is unsupported.`);
  }
}

function isIdempotentMethod(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method);
}

async function pinnedFetch(
  validated: ValidatedSafeUrl,
  init: RequestInit
): Promise<Response> {
  const method = normalizeMethod(
    typeof init.method === 'string' ? init.method : undefined
  );
  assertAllowedFetchMethod(method);

  if (!validated.addresses.length) {
    // DNS resolution disabled — fall back to normal fetch (no pin available).
    return fetch(validated.url.href, { ...init, redirect: 'manual' });
  }

  const useBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
  let lastError: unknown;
  const idempotent = isIdempotentMethod(method);

  // Try validated addresses in resolver order. Only retry after transport errors
  // for idempotent methods — otherwise a POST/PATCH may have already been processed.
  for (let i = 0; i < validated.addresses.length; i++) {
    const pinned = validated.addresses[i];
    try {
      if (useBun) {
        return await bunPinnedFetch(validated.url, pinned, init);
      }
      return await nodePinnedFetch(validated.url, pinned, init);
    } catch (err) {
      if (isAbortError(err) || init.signal?.aborted) {
        throw err;
      }
      lastError = err;
      const moreAddresses = i < validated.addresses.length - 1;
      if (!idempotent || !moreAddresses) {
        throw err instanceof Error
          ? err
          : new Error(`All validated addresses failed for ${validated.url.hostname}`);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`All validated addresses failed for ${validated.url.hostname}`);
}

function setPinnedHostname(requestUrl: URL, pinned: { address: string; family: number }): void {
  // URL.hostname ignores bare IPv6 literals; bracket them (or set host) so the pin sticks.
  if (pinned.family === 6 || isIP(pinned.address) === 6) {
    const port = requestUrl.port;
    requestUrl.host = port ? `[${pinned.address}]:${port}` : `[${pinned.address}]`;
  } else {
    requestUrl.hostname = pinned.address;
  }
}

async function bunPinnedFetch(
  url: URL,
  pinned: { address: string; family: number },
  init: RequestInit
): Promise<Response> {
  const requestUrl = new URL(url.href);
  setPinnedHostname(requestUrl, pinned);

  const headers = new Headers(init.headers);
  // Always pin Host to the validated URL host so callers cannot smuggle virtual hosts.
  headers.set('host', url.host);

  return fetch(requestUrl.href, {
    ...init,
    headers,
    redirect: 'manual',
    // Bun-specific: keep SNI/certificate validation on the original hostname.
    tls: { serverName: stripIpv6Brackets(url.hostname) },
  } as RequestInit);
}

async function nodePinnedFetch(
  url: URL,
  pinned: { address: string; family: number },
  init: RequestInit
): Promise<Response> {
  const lib = url.protocol === 'https:' ? https : http;
  const headers = new Headers(init.headers);
  // Always pin Host to the validated URL host so callers cannot smuggle virtual hosts.
  headers.set('host', url.host);

  const body = await serializeNodeBody(init.body ?? undefined, headers);

  const headerObject: Record<string, string> = {};
  headers.forEach((value, key) => {
    headerObject[key] = value;
  });

  // Node TLS treats bracketed IPv6 literals as DNS names; strip for SNI/cert matching.
  const tlsServerName = stripIpv6Brackets(url.hostname);

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: tlsServerName,
        servername: tlsServerName,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers: headerObject,
        lookup: (_hostname, options, callback) => {
          const cb = callback as (
            err: Error | null,
            address: string | { address: string; family: number }[],
            family?: number
          ) => void;
          if (options?.all) {
            cb(null, [{ address: pinned.address, family: pinned.family }]);
          } else {
            cb(null, pinned.address, pinned.family);
          }
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // Web Response only accepts 200–599; out-of-range values throw synchronously
        // inside this callback and would terminate the process instead of rejecting.
        if (status < 200 || status > 599) {
          res.resume();
          settle(() =>
            reject(new Error(`Unsupported HTTP status code from upstream: ${status}`))
          );
          return;
        }

        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(key, item);
          } else {
            responseHeaders.set(key, value);
          }
        }

        // Web Response rejects bodies for null-body statuses; drain and pass null.
        if (NULL_BODY_STATUS.has(status)) {
          res.resume();
          settle(() =>
            resolve(
              new Response(null, {
                status,
                statusText: res.statusMessage ?? '',
                headers: responseHeaders,
              })
            )
          );
          return;
        }

        const decoded = decodeContentEncoding(res, responseHeaders);
        settle(() =>
          resolve(
            new Response(Readable.toWeb(decoded) as ReadableStream, {
              status,
              statusText: res.statusMessage ?? '',
              headers: responseHeaders,
            })
          )
        );
      }
    );

    const signal = init.signal;
    let onAbort: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) {
        req.destroy(abortError(signal.reason));
        settle(() => reject(abortError(signal.reason)));
        return;
      }
      onAbort = () => {
        req.destroy(abortError(signal.reason));
        settle(() => reject(abortError(signal.reason)));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => {
        if (onAbort) signal.removeEventListener('abort', onAbort);
      });
    }

    // 101 Switching Protocols emits `upgrade` instead of the response callback;
    // reject so timeouts/callers are not left hanging.
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      req.destroy();
      settle(() =>
        reject(new Error('Protocol upgrade (101 Switching Protocols) is not supported by safeFetch'))
      );
    });

    // CONNECT success emits `connect` rather than `response`/`upgrade`.
    req.on('connect', (_res, socket) => {
      socket.destroy();
      req.destroy();
      settle(() =>
        reject(new Error('CONNECT tunneling is not supported by safeFetch'))
      );
    });

    req.on('error', (err) => settle(() => reject(err)));
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * Decode Content-Encoding like native Fetch, and strip encoding/length headers once decoded.
 */
function decodeContentEncoding(res: IncomingMessage, headers: Headers): Readable {
  const encoding = String(headers.get('content-encoding') ?? '')
    .toLowerCase()
    .trim();

  let stream: Readable = res;
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    stream = res.pipe(createGunzip());
  } else if (encoding === 'deflate') {
    stream = res.pipe(createInflate());
  } else if (encoding === 'br') {
    stream = res.pipe(createBrotliDecompress());
  } else {
    return res;
  }

  headers.delete('content-encoding');
  headers.delete('content-length');
  return stream;
}
