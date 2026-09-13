import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { PassThrough, Readable, pipeline } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { IncomingMessage } from 'node:http';
import type { Transform } from 'node:stream';

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

/** Match native Fetch: responses after following a redirect report redirected === true. */
function stampRedirected(response: Response, redirected: boolean): Response {
  if (redirected && !response.redirected) {
    Object.defineProperty(response, 'redirected', {
      value: true,
      configurable: true,
      enumerable: true,
    });
  }
  return response;
}

/**
 * Apply Fetch referrer / referrerPolicy to the outbound Referer header.
 * Server-side `about:client` has no document URL, so it leaves Referer unchanged.
 */
function applyReferrerHeaders(
  headers: Headers,
  requestUrl: URL,
  init: RequestInit
): void {
  const referrer = init.referrer;
  if (referrer === undefined || referrer === 'about:client') {
    return;
  }
  if (referrer === '') {
    headers.delete('referer');
    return;
  }

  let referrerUrl: URL;
  try {
    referrerUrl = new URL(referrer);
  } catch {
    return;
  }

  if (referrerUrl.protocol !== 'http:' && referrerUrl.protocol !== 'https:') {
    headers.delete('referer');
    return;
  }

  const policy = (init.referrerPolicy || 'strict-origin-when-cross-origin') as string;
  const value = serializeReferrer(referrerUrl, requestUrl, policy);
  if (value === null) {
    headers.delete('referer');
  } else {
    headers.set('referer', value);
  }
}

function originString(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function isDowngrade(referrerUrl: URL, requestUrl: URL): boolean {
  return referrerUrl.protocol === 'https:' && requestUrl.protocol !== 'https:';
}

function isSameOrigin(a: URL, b: URL): boolean {
  return (
    a.protocol === b.protocol &&
    a.hostname.toLowerCase() === b.hostname.toLowerCase() &&
    a.port === b.port
  );
}

/** Fetch strips credentials and fragments before serializing Referer. */
function sanitizeReferrerUrl(referrerUrl: URL): URL {
  const clean = new URL(referrerUrl.href);
  clean.username = '';
  clean.password = '';
  clean.hash = '';
  return clean;
}

/** Serialize a referrer URL per Referrer-Policy (returns null for no-referrer). */
function serializeReferrer(
  referrerUrl: URL,
  requestUrl: URL,
  policy: string
): string | null {
  const sanitized = sanitizeReferrerUrl(referrerUrl);
  const full = sanitized.href;
  const origin = originString(sanitized);
  const sameOrigin = isSameOrigin(sanitized, requestUrl);
  const downgrade = isDowngrade(sanitized, requestUrl);

  switch (policy) {
    case 'no-referrer':
      return null;
    case 'unsafe-url':
      return full;
    case 'origin':
      return `${origin}/`;
    case 'origin-when-cross-origin':
      return sameOrigin ? full : `${origin}/`;
    case 'same-origin':
      return sameOrigin ? full : null;
    case 'no-referrer-when-downgrade':
      return downgrade ? null : full;
    case 'strict-origin':
      return downgrade ? null : `${origin}/`;
    case 'strict-origin-when-cross-origin':
    case '':
      if (sameOrigin) return full;
      return downgrade ? null : `${origin}/`;
    default:
      // Unknown policy — fail closed like no-referrer for safety.
      return null;
  }
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

  // Strip brackets and a single trailing DNS root dot so localhost. / metadata.google.internal.
  // match the same blocklist/allowlist entries as their non-FQDN forms.
  const hostname = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');

  if (!hostname) {
    throw new Error('URL hostname is required');
  }

  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new Error(`Blocked hostname: ${hostname}`);
  }

  // Distinguish undefined (no allowlist) from [] (fail-closed: reject all hosts).
  if (allowedHosts !== undefined) {
    const allowed = new Set(
      allowedHosts.map((h) => h.toLowerCase().replace(/\.$/, ''))
    );
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

function ipv4FromHextets(hi: string, lo: string): string {
  const h = parseInt(hi, 16);
  const l = parseInt(lo, 16);
  return `${(h >> 8) & 0xff}.${h & 0xff}.${(l >> 8) & 0xff}.${l & 0xff}`;
}

function hextetsAreZero(hextets: string[]): boolean {
  return hextets.every((h) => parseInt(h, 16) === 0);
}

function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // ::1 loopback / :: unspecified — keep explicit for clarity before expansion edge cases
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
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

  // IPv4-mapped ::ffff:0:0/96 — 0000:0000:0000:0000:0000:ffff:xxxx:xxxx
  if (hextetsAreZero(full.slice(0, 5)) && parseInt(full[5], 16) === 0xffff) {
    return isBlockedIpv4(ipv4FromHextets(full[6], full[7]));
  }

  // IPv4-translated / SIIT ::ffff:0:0/96 — 0000:0000:0000:0000:ffff:0000:xxxx:xxxx
  if (
    hextetsAreZero(full.slice(0, 4)) &&
    parseInt(full[4], 16) === 0xffff &&
    parseInt(full[5], 16) === 0
  ) {
    return isBlockedIpv4(ipv4FromHextets(full[6], full[7]));
  }

  // Deprecated IPv4-compatible ::/96 — 0000:0000:0000:0000:0000:0000:xxxx:xxxx
  if (hextetsAreZero(full.slice(0, 6))) {
    return isBlockedIpv4(ipv4FromHextets(full[6], full[7]));
  }

  // NAT64 well-known prefix 64:ff9b::/96
  if (
    first === 0x0064 &&
    second === 0xff9b &&
    hextetsAreZero(full.slice(2, 6))
  ) {
    return isBlockedIpv4(ipv4FromHextets(full[6], full[7]));
  }

  // NAT64 local-use prefix 64:ff9b:1::/48 (RFC 8215) — reject entirely.
  // Translators may embed arbitrary IPv4 (including private) under this /48.
  if (first === 0x0064 && second === 0xff9b && parseInt(full[2], 16) === 0x0001) {
    return true;
  }

  // 6to4 2002::/16 embeds IPv4 in bits 16–47
  if (first === 0x2002) {
    return isBlockedIpv4(ipv4FromHextets(full[1], full[2]));
  }

  return false;
}

/**
 * Expand an IPv6 literal to 8 hextets. Trailing dotted-quad forms
 * (e.g. ::127.0.0.1, 64:ff9b::169.254.169.254) are converted to two hextets first.
 */
function expandIpv6(ip: string): string[] | null {
  let working = ip.toLowerCase();

  const dotted = working.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const parts = dotted[2].split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((parts[0] << 8) | parts[1]).toString(16);
    const lo = ((parts[2] << 8) | parts[3]).toString(16);
    working = `${dotted[1]}${hi}:${lo}`;
  }

  const halves = working.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':').filter((h) => h.length > 0) : [];
  const tail =
    halves.length === 2 && halves[1] ? halves[1].split(':').filter((h) => h.length > 0) : [];

  // Reject non-hex hextets (e.g. leftover dotted debris).
  if (![...head, ...tail].every((h) => /^[0-9a-f]{1,4}$/i.test(h))) {
    return null;
  }

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
 * `mode` is supported for `same-origin` / `cors` / `no-cors` request constraints.
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
  const initialMethod = normalizeMethod(fetchInit.method);
  assertAllowedFetchMethod(initialMethod);
  assertMethodBodyCompatible(initialMethod, fetchInit.body);
  const requestMode = fetchInit.mode ?? 'cors';
  assertNoCorsMethodAllowed(requestMode, initialMethod);
  assertOnlyIfCachedMode(fetchInit.cache, requestMode);
  let current = url;
  let requestInit: RequestInit = { ...fetchInit };
  const initialOrigin = new URL(url).origin;
  let followedRedirect = false;

  for (let i = 0; i <= maxRedirects; i++) {
    if (requestMode === 'same-origin') {
      const targetOrigin = new URL(current).origin;
      if (targetOrigin !== initialOrigin) {
        throw new TypeError(
          `Failed to fetch: '${requestMode}' mode forbids cross-origin request to ${current}`
        );
      }
    }

    const validated = await validateSafeHttpUrl(current, {
      ...urlSafety,
      signal: requestInit.signal ?? urlSafety?.signal,
    });

    const response = stampRedirected(
      stampLogicalUrl(await pinnedFetch(validated, requestInit), current),
      followedRedirect
    );

    if (!REDIRECT_STATUS.has(response.status)) {
      return response;
    }

    const location = response.headers.get('location');
    // Native Fetch returns redirect responses without Location unchanged.
    if (!location) {
      return response;
    }

    // Cancel unused redirect body so sockets are not held open.
    await cancelResponseBody(response);

    const nextUrl = new URL(location, current);
    const crossOrigin = !sameOrigin(current, nextUrl.href);
    requestInit = nextRedirectInit(requestInit, response.status, crossOrigin);
    current = nextUrl.href;
    followedRedirect = true;
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
    // Fetch removes all body-related headers when the body is dropped.
    headers.delete('content-length');
    headers.delete('content-type');
    headers.delete('content-encoding');
    headers.delete('content-language');
    headers.delete('content-location');
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

type PreparedNodeBody =
  | { kind: 'buffer'; value: string | Buffer }
  | { kind: 'stream'; stream: ReadableStream<Uint8Array> };

/**
 * Prepare RequestInit body forms for the Node http(s) transport.
 * ReadableStream is kept streaming so abort can cancel mid-upload;
 * other forms are normalized via Request (URLSearchParams/FormData/Blob/…).
 */
async function prepareNodeBody(
  body: BodyInit | null | undefined,
  headers: Headers
): Promise<PreparedNodeBody | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') {
    // Match Fetch: string bodies default to text/plain;charset=UTF-8.
    if (!headers.has('content-type')) {
      headers.set('content-type', 'text/plain;charset=UTF-8');
    }
    return { kind: 'buffer', value: body };
  }
  if (Buffer.isBuffer(body)) {
    return { kind: 'buffer', value: body };
  }
  if (body instanceof Uint8Array) {
    return { kind: 'buffer', value: Buffer.from(body) };
  }
  if (body instanceof ArrayBuffer) {
    return { kind: 'buffer', value: Buffer.from(body) };
  }
  if (ArrayBuffer.isView(body)) {
    return {
      kind: 'buffer',
      value: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
    };
  }

  // Keep ReadableStream abortable — do not materialize the whole upload first.
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    return { kind: 'stream', stream: body as ReadableStream<Uint8Array> };
  }

  // Stream Blob/File uploads instead of buffering the entire payload.
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    if (body.type && !headers.has('content-type')) {
      headers.set('content-type', body.type);
    }
    return { kind: 'stream', stream: body.stream() as ReadableStream<Uint8Array> };
  }

  // FormData / URLSearchParams: encode via Request, then stream the body when available.
  const tmp = new Request('http://local.invalid', {
    method: 'POST',
    body,
    // Node requires duplex for streaming request bodies produced from FormData.
    duplex: 'half',
  } as RequestInit);
  const contentType = tmp.headers.get('content-type');
  if (contentType && !headers.has('content-type')) {
    headers.set('content-type', contentType);
  }
  if (tmp.body) {
    return { kind: 'stream', stream: tmp.body as ReadableStream<Uint8Array> };
  }
  return { kind: 'buffer', value: Buffer.from(await tmp.arrayBuffer()) };
}

/**
 * Pipe a web ReadableStream to a Node ClientRequest with backpressure and abort.
 */
async function pipeWebStreamToRequest(
  stream: ReadableStream<Uint8Array>,
  req: http.ClientRequest,
  signal?: AbortSignal | null
): Promise<void> {
  const reader = stream.getReader();
  let onAbort: (() => void) | undefined;

  if (signal) {
    if (signal.aborted) {
      await reader.cancel(signal.reason).catch(() => undefined);
      throw abortError(signal.reason);
    }
    onAbort = () => {
      void reader.cancel(signal.reason).catch(() => undefined);
      req.destroy(abortError(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (true) {
      if (signal?.aborted) {
        throw abortError(signal.reason);
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      const chunk = Buffer.from(value);
      if (!req.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            cleanup();
            resolve();
          };
          const onError = (err: Error) => {
            cleanup();
            reject(err);
          };
          const cleanup = () => {
            req.off('drain', onDrain);
            req.off('error', onError);
          };
          req.once('drain', onDrain);
          req.once('error', onError);
        });
      }
    }
    req.end();
  } catch (err) {
    await reader.cancel(err).catch(() => undefined);
    // Ensure the ClientRequest does not retain an open socket after upload failure.
    if (!req.destroyed) {
      req.destroy(err instanceof Error ? err : undefined);
    }
    throw err;
  } finally {
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'TRACE']);
const FORBIDDEN_FETCH_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK']);
/** Fetch CORS-safelisted methods — the only methods allowed in no-cors mode. */
const NO_CORS_METHODS = new Set(['GET', 'HEAD', 'POST']);

function normalizeMethod(method: string | undefined): string {
  return (method ?? 'GET').toUpperCase();
}

function assertAllowedFetchMethod(method: string): void {
  if (FORBIDDEN_FETCH_METHODS.has(method)) {
    throw new TypeError(`'${method}' HTTP method is unsupported.`);
  }
}

function assertMethodBodyCompatible(
  method: string,
  body: BodyInit | null | undefined
): void {
  if (body != null && (method === 'GET' || method === 'HEAD')) {
    throw new TypeError(`Request with ${method} method cannot have a body.`);
  }
}

function assertNoCorsMethodAllowed(
  mode: RequestInit['mode'] | undefined,
  method: string
): void {
  if (mode === 'no-cors' && !NO_CORS_METHODS.has(method)) {
    throw new TypeError(`'${method}' is not allowed in 'no-cors' mode.`);
  }
}

/** Fetch rejects only-if-cached unless mode is same-origin. */
function assertOnlyIfCachedMode(
  cache: RequestInit['cache'] | undefined,
  mode: RequestInit['mode'] | undefined
): void {
  if (cache === 'only-if-cached' && mode !== 'same-origin') {
    throw new TypeError(
      `'only-if-cached' cache mode can only be used with 'same-origin' request mode.`
    );
  }
}

function isIdempotentMethod(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method);
}

/** ReadableStream bodies are one-shot; do not retry them across addresses. */
function isReplayableBody(body: BodyInit | null | undefined): boolean {
  if (body == null) return true;
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    return false;
  }
  return true;
}

async function pinnedFetch(
  validated: ValidatedSafeUrl,
  init: RequestInit
): Promise<Response> {
  const method = normalizeMethod(
    typeof init.method === 'string' ? init.method : undefined
  );
  assertAllowedFetchMethod(method);
  assertMethodBodyCompatible(method, init.body);

  if (!validated.addresses.length) {
    // DNS resolution disabled — fall back to normal fetch (no pin available).
    return fetch(validated.url.href, { ...init, redirect: 'manual' });
  }

  const useBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
  let lastError: unknown;
  // Only retry after transport errors for idempotent methods with replayable bodies —
  // otherwise a POST/PATCH may have already been processed, or a ReadableStream is locked.
  const canRetry = isIdempotentMethod(method) && isReplayableBody(init.body);

  for (let i = 0; i < validated.addresses.length; i++) {
    const pinned = validated.addresses[i];
    try {
      if (useBun && canUseBunPinnedFetch(validated.url)) {
        return await bunPinnedFetch(validated.url, pinned, init);
      }
      return await nodePinnedFetch(validated.url, pinned, init);
    } catch (err) {
      if (isAbortError(err) || init.signal?.aborted) {
        throw err;
      }
      lastError = err;
      const moreAddresses = i < validated.addresses.length - 1;
      if (!canRetry || !moreAddresses) {
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

/**
 * Bun's fetch `tls.serverName` is unreliable on engines declared as `bun >=1.0`
 * (e.g. 1.2.14 ignores it for cert verification). Prefer Node's `servername` for
 * HTTPS DNS hostnames; Bun fetch remains fine for plain HTTP and IP-literal HTTPS
 * (certificate identity already matches the pinned address).
 */
function canUseBunPinnedFetch(url: URL): boolean {
  if (url.protocol !== 'https:') {
    return true;
  }
  return isIP(stripIpv6Brackets(url.hostname)) !== 0;
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
  applyReferrerHeaders(headers, url, init);

  const fetchInit: RequestInit & { tls?: { serverName: string } } = {
    ...init,
    headers,
    redirect: 'manual',
  };
  // Referer is applied via headers; avoid double-application by the runtime.
  delete fetchInit.referrer;
  delete fetchInit.referrerPolicy;
  if (url.protocol === 'https:') {
    // Retain original hostname for SNI/cert checks when Bun honors it (IP-literal HTTPS).
    fetchInit.tls = { serverName: stripIpv6Brackets(url.hostname) };
  }

  return fetch(requestUrl.href, fetchInit);
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
  applyReferrerHeaders(headers, url, init);

  const body = await prepareNodeBody(init.body ?? undefined, headers);

  // Never trust caller-supplied framing — a mismatched Content-Length/Transfer-Encoding
  // can smuggle a second request past Host pinning on keep-alive proxies.
  headers.delete('content-length');
  headers.delete('transfer-encoding');
  if (body?.kind === 'buffer') {
    headers.set('content-length', String(Buffer.byteLength(body.value)));
  }
  // Streaming bodies: omit Content-Length so Node uses chunked transfer automatically.

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
        // Disable the global agent pool so idle sockets keyed by hostname cannot
        // bypass the pin lookup (DNS rebinding via keep-alive reuse).
        agent: false,
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

        // Web Response rejects bodies for null-body statuses; HEAD responses also
        // have a null body even when status is not in NULL_BODY_STATUS.
        const methodUpper = normalizeMethod(
          typeof init.method === 'string' ? init.method : undefined
        );
        if (NULL_BODY_STATUS.has(status) || methodUpper === 'HEAD') {
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
        if (body?.kind === 'stream') {
          void body.stream.cancel(signal.reason).catch(() => undefined);
        }
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

    if (body?.kind === 'stream') {
      void pipeWebStreamToRequest(body.stream, req, signal).catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (!req.destroyed) {
          req.destroy(error);
        }
        settle(() => reject(error));
      });
      return;
    }

    if (body?.kind === 'buffer') {
      req.write(body.value);
    }
    req.end();
  });
}

/**
 * Decode Content-Encoding like native Fetch (including multiple codings),
 * and strip encoding/length headers once decoded.
 */
function decodeContentEncoding(res: IncomingMessage, headers: Headers): Readable {
  const encodingHeader = String(headers.get('content-encoding') ?? '')
    .toLowerCase()
    .trim();
  if (!encodingHeader) {
    return res;
  }

  const codings = encodingHeader
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== 'identity');
  if (codings.length === 0) {
    headers.delete('content-encoding');
    headers.delete('content-length');
    return res;
  }

  // Validate every coding before piping so an unknown token cannot partially consume the body.
  for (const coding of codings) {
    if (
      coding !== 'gzip' &&
      coding !== 'x-gzip' &&
      coding !== 'deflate' &&
      coding !== 'br'
    ) {
      return res;
    }
  }

  // Decode in reverse application order (Fetch-compatible).
  // Use pipeline() so upstream socket / intermediate decoder errors propagate to
  // the final stream consumed via Readable.toWeb (plain pipe() does not).
  const transforms: Transform[] = [];
  for (let i = codings.length - 1; i >= 0; i--) {
    const coding = codings[i];
    if (coding === 'gzip' || coding === 'x-gzip') {
      transforms.push(createGunzip());
    } else if (coding === 'deflate') {
      transforms.push(createInflate());
    } else {
      transforms.push(createBrotliDecompress());
    }
  }

  const output = new PassThrough();
  pipeline([res, ...transforms, output], (err) => {
    if (err && !output.destroyed) {
      output.destroy(err);
    }
  });

  headers.delete('content-encoding');
  headers.delete('content-length');
  return output;
}
