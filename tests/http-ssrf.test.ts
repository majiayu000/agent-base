import { describe, expect, it, mock, spyOn } from 'bun:test';
import { assertSafeHttpUrl, getSafeFetchUrl, safeFetch } from '../src/utils/url-safety.js';
import { httpGetTool, httpPostTool, fetchJsonTool } from '../src/tools/http.js';
import https from 'node:https';
import * as dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';

/**
 * SSRF guard tests — blocked URLs must fail before any network I/O.
 * We stub global fetch so a pass would still not touch the network; a regression
 * that skipped validation would call fetch and fail these assertions.
 */
describe('assertSafeHttpUrl', () => {
  it('rejects http by default', async () => {
    await expect(assertSafeHttpUrl('http://example.com/', { resolveDns: false })).rejects.toThrow(
      /http:/i
    );
  });

  it('rejects non-http schemes', async () => {
    await expect(assertSafeHttpUrl('file:///etc/passwd')).rejects.toThrow(/scheme/i);
    await expect(assertSafeHttpUrl('ftp://example.com/')).rejects.toThrow(/scheme/i);
  });

  it('rejects localhost hostname without DNS', async () => {
    await expect(
      assertSafeHttpUrl('https://localhost/secret', { resolveDns: false })
    ).rejects.toThrow(/localhost/i);
  });

  it('rejects loopback literal IPs', async () => {
    await expect(assertSafeHttpUrl('https://127.0.0.1/')).rejects.toThrow(/blocked/i);
    await expect(assertSafeHttpUrl('https://127.0.0.1:8443/admin')).rejects.toThrow(/blocked/i);
  });

  it('rejects cloud metadata link-local address', async () => {
    await expect(assertSafeHttpUrl('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /blocked/i
    );
  });

  it('rejects private RFC1918 ranges', async () => {
    await expect(assertSafeHttpUrl('https://10.0.0.1/')).rejects.toThrow(/blocked/i);
    await expect(assertSafeHttpUrl('https://192.168.1.1/')).rejects.toThrow(/blocked/i);
    await expect(assertSafeHttpUrl('https://172.16.5.1/')).rejects.toThrow(/blocked/i);
  });

  it('rejects full 198.18.0.0/15 benchmarking range', async () => {
    await expect(assertSafeHttpUrl('https://198.18.0.1/')).rejects.toThrow(/blocked/i);
    await expect(assertSafeHttpUrl('https://198.19.255.255/')).rejects.toThrow(/blocked/i);
  });

  it('rejects documentation /24 prefixes but not adjacent public /16 addresses', async () => {
    await expect(assertSafeHttpUrl('https://192.0.2.1/')).rejects.toThrow(/blocked/i);
    await expect(assertSafeHttpUrl('https://198.51.100.1/')).rejects.toThrow(/blocked/i);
    await expect(assertSafeHttpUrl('https://203.0.113.1/')).rejects.toThrow(/blocked/i);

    // Adjacent addresses outside the reserved /24 must not be blanket-blocked by /16 checks.
    await expect(
      assertSafeHttpUrl('https://198.51.101.1/', { resolveDns: false })
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertSafeHttpUrl('https://203.0.114.1/', { resolveDns: false })
    ).resolves.toBeInstanceOf(URL);
  });

  it('rejects IPv6 documentation, discard-only, and benchmarking ranges', async () => {
    await expect(assertSafeHttpUrl('https://[2001:db8::1]/')).rejects.toThrow(/blocked/i);
    await expect(assertSafeHttpUrl('https://[100::1]/')).rejects.toThrow(/blocked/i);
    await expect(assertSafeHttpUrl('https://[2001:2::1]/')).rejects.toThrow(/blocked/i);
  });

  it('rejects IPv6 loopback and link-local', async () => {
    await expect(assertSafeHttpUrl('https://[::1]/')).rejects.toThrow(/blocked/i);
    await expect(assertSafeHttpUrl('https://[fe80::1]/')).rejects.toThrow(/blocked/i);
  });

  it('rejects deprecated site-local IPv6 fec0::/10', async () => {
    await expect(assertSafeHttpUrl('https://[fec0::1]/')).rejects.toThrow(/blocked/i);
    await expect(assertSafeHttpUrl('https://[fed0::1]/')).rejects.toThrow(/blocked/i);
  });

  it('rejects IPv4-embedded IPv6 forms that smuggle loopback/private/metadata', async () => {
    // Deprecated IPv4-compatible ::/96
    await expect(assertSafeHttpUrl('https://[::127.0.0.1]/')).rejects.toThrow(/blocked/i);
    await expect(assertSafeHttpUrl('https://[::7f00:1]/')).rejects.toThrow(/blocked/i);
    // SIIT / IPv4-translated ::ffff:0:0/96
    await expect(assertSafeHttpUrl('https://[::ffff:0:7f00:1]/')).rejects.toThrow(/blocked/i);
    await expect(assertSafeHttpUrl('https://[::ffff:0:127.0.0.1]/')).rejects.toThrow(/blocked/i);
    // NAT64 well-known prefix 64:ff9b::/96
    await expect(assertSafeHttpUrl('https://[64:ff9b::127.0.0.1]/')).rejects.toThrow(/blocked/i);
    await expect(assertSafeHttpUrl('https://[64:ff9b::7f00:1]/')).rejects.toThrow(/blocked/i);
    // NAT64 local-use prefix 64:ff9b:1::/48 (embeds private IPv4 under translator)
    await expect(assertSafeHttpUrl('https://[64:ff9b:1::a00:1]/')).rejects.toThrow(/blocked/i);
    await expect(assertSafeHttpUrl('https://[64:ff9b:1:0:0:0:a00:1]/')).rejects.toThrow(/blocked/i);
    // 6to4 2002::/16 embedding 169.254.169.254
    await expect(assertSafeHttpUrl('https://[2002:a9fe:a9fe::]')).rejects.toThrow(/blocked/i);
    await expect(assertSafeHttpUrl('https://[2002:7f00:1::]')).rejects.toThrow(/blocked/i);
  });

  it('rejects numeric hostname smuggling', async () => {
    // URL parsers may normalize 2130706433 → 127.0.0.1; either form must be blocked
    await expect(
      assertSafeHttpUrl('https://2130706433/', { resolveDns: false })
    ).rejects.toThrow(/blocked|numeric/i);
  });

  it('allows https public hostname when DNS resolution is skipped', async () => {
    const url = await assertSafeHttpUrl('https://example.com/path', { resolveDns: false });
    expect(url.hostname).toBe('example.com');
  });

  it('canonicalizes trailing DNS root dots before hostname checks', async () => {
    await expect(
      assertSafeHttpUrl('https://localhost./secret', { resolveDns: false })
    ).rejects.toThrow(/localhost/i);
    await expect(
      assertSafeHttpUrl('https://metadata.google.internal./', { resolveDns: false })
    ).rejects.toThrow(/metadata/i);

    const ok = await assertSafeHttpUrl('https://example.com./path', {
      resolveDns: false,
      allowedHosts: ['example.com'],
    });
    expect(ok.hostname.replace(/\.$/, '')).toBe('example.com');
  });

  it('enforces optional host allowlist', async () => {
    await expect(
      assertSafeHttpUrl('https://evil.example/', {
        resolveDns: false,
        allowedHosts: ['api.example.com'],
      })
    ).rejects.toThrow(/allowlist/i);

    const ok = await assertSafeHttpUrl('https://api.example.com/v1', {
      resolveDns: false,
      allowedHosts: ['api.example.com'],
    });
    expect(ok.hostname).toBe('api.example.com');
  });

  it('treats an empty allowlist as fail-closed', async () => {
    await expect(
      assertSafeHttpUrl('https://example.com/', {
        resolveDns: false,
        allowedHosts: [],
      })
    ).rejects.toThrow(/allowlist/i);
  });
});

describe('safeFetch redirect semantics', () => {
  it('returns 304 to the caller instead of treating it as a redirect', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, { status: 304, statusText: 'Not Modified' })) as typeof fetch;

    try {
      const response = await safeFetch('https://1.1.1.1/resource', { method: 'GET' });
      expect(response.status).toBe(304);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('converts POST 302 redirects to GET without body', async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown; headers: Headers }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({
        url: href,
        method: init?.method,
        body: init?.body,
        headers: new Headers(init?.headers),
      });
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://1.0.0.1/next' },
        });
      }
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    try {
      const response = await safeFetch('https://1.1.1.1/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'identity',
          'Content-Language': 'en',
          'Content-Location': 'https://1.1.1.1/original',
          Authorization: 'Bearer secret',
        },
        body: JSON.stringify({ a: 1 }),
      });
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(2);
      expect((calls[0].method ?? 'GET').toUpperCase()).toBe('POST');
      expect((calls[1].method ?? 'GET').toUpperCase()).toBe('GET');
      expect(calls[1].body == null || calls[1].body === '').toBe(true);
      // Cross-origin redirect must drop Authorization
      expect(calls[1].headers.get('authorization')).toBeNull();
      // Body-describing headers must all be removed when the body is dropped
      expect(calls[1].headers.get('content-type')).toBeNull();
      expect(calls[1].headers.get('content-encoding')).toBeNull();
      expect(calls[1].headers.get('content-language')).toBeNull();
      expect(calls[1].headers.get('content-location')).toBeNull();
      expect(calls[1].headers.get('content-length')).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('rejects cross-origin redirects when mode is same-origin', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://1.0.0.1/cross' },
      })) as typeof fetch;

    try {
      await expect(
        safeFetch('https://1.1.1.1/start', { mode: 'same-origin' })
      ).rejects.toThrow(/same-origin/i);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('strips credentials on cross-origin redirects and keeps them on same-origin', async () => {
    const authHeaders: Array<string | null> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      authHeaders.push(new Headers(init?.headers).get('authorization'));
      if (authHeaders.length === 1) {
        return new Response(null, {
          status: 307,
          headers: { Location: 'https://1.1.1.1/same-origin' },
        });
      }
      if (authHeaders.length === 2) {
        return new Response(null, {
          status: 307,
          headers: { Location: 'https://1.0.0.1/cross-origin' },
        });
      }
      return new Response(`done:${href}`, { status: 200 });
    }) as typeof fetch;

    try {
      await safeFetch('https://1.1.1.1/start', {
        method: 'GET',
        headers: { Authorization: 'Bearer keep-me' },
      });
      expect(authHeaders[0]).toBe('Bearer keep-me');
      expect(authHeaders[1]).toBe('Bearer keep-me');
      expect(authHeaders[2]).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('pins Bun fetch to a validated literal address with Host/SNI retained', async () => {
    const original = globalThis.fetch;
    let sawPinned = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      // Literal IP validation pins to itself; Host should still be set for hostname URLs.
      if (href.startsWith('https://1.1.1.1/')) {
        sawPinned = true;
        expect(headers.get('host')).toBe('1.1.1.1');
      }
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    try {
      const response = await safeFetch('https://1.1.1.1/pin-check');
      expect(response.status).toBe(200);
      expect(sawPinned).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('overrides caller-supplied Host with the validated URL host', async () => {
    const original = globalThis.fetch;
    let seenHost: string | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenHost = new Headers(init?.headers).get('host');
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    try {
      await safeFetch('https://1.1.1.1/vhost', {
        headers: { Host: 'admin.internal' },
      });
      expect(seenHost).toBe('1.1.1.1');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('accepts URLSearchParams bodies on the Bun pinned path', async () => {
    const original = globalThis.fetch;
    let seenBody: unknown;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenBody = init?.body;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    try {
      const body = new URLSearchParams({ a: '1', b: '2' });
      const response = await safeFetch('https://1.1.1.1/form', {
        method: 'POST',
        body,
      });
      expect(response.status).toBe(200);
      expect(seenBody).toBeInstanceOf(URLSearchParams);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('brackets IPv6 addresses when pinning Bun requests', async () => {
    const original = globalThis.fetch;
    let pinnedHref = '';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      pinnedHref =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      expect(headers.get('host')).toBe('[2606:4700:4700::1111]');
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    try {
      const response = await safeFetch('https://[2606:4700:4700::1111]/ipv6-pin');
      expect(response.status).toBe(200);
      expect(pinnedHref).toContain('https://[2606:4700:4700::1111]/');
      expect(getSafeFetchUrl(response)).toBe('https://[2606:4700:4700::1111]/ipv6-pin');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('preserves PUT across 301/302 but converts POST and all methods on 303', async () => {
    const calls: Array<{ method?: string; body?: unknown }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method, body: init?.body });
      if (calls.length === 1) {
        return new Response(null, {
          status: 301,
          headers: { Location: 'https://1.0.0.1/after-301' },
        });
      }
      if (calls.length === 2) {
        return new Response(null, {
          status: 303,
          headers: { Location: 'https://1.0.0.1/after-303' },
        });
      }
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    try {
      await safeFetch('https://1.1.1.1/resource', {
        method: 'PUT',
        body: 'payload',
        headers: { 'Content-Type': 'text/plain' },
      });
      expect((calls[0].method ?? 'GET').toUpperCase()).toBe('PUT');
      // 301 must preserve PUT (unlike POST)
      expect((calls[1].method ?? 'GET').toUpperCase()).toBe('PUT');
      expect(calls[1].body).toBe('payload');
      // 303 converts non-GET/HEAD to GET
      expect((calls[2].method ?? 'GET').toUpperCase()).toBe('GET');
      expect(calls[2].body == null || calls[2].body === '').toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('exposes the logical final URL after redirects', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (href.includes('/start')) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://1.0.0.1/final' },
        });
      }
      return new Response('done', { status: 200 });
    }) as typeof fetch;

    try {
      const response = await safeFetch('https://1.1.1.1/start');
      expect(getSafeFetchUrl(response)).toBe('https://1.0.0.1/final');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('sets response.redirected after following a Location redirect', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (href.includes('/start')) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://1.0.0.1/final' },
        });
      }
      return new Response('done', { status: 200 });
    }) as typeof fetch;

    try {
      const redirected = await safeFetch('https://1.1.1.1/start');
      expect(redirected.redirected).toBe(true);
      expect(redirected.status).toBe(200);

      const direct = await safeFetch('https://1.1.1.1/direct');
      expect(direct.redirected).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('applies referrer and referrerPolicy to the Referer header', async () => {
    const original = globalThis.fetch;
    let seenReferer: string | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenReferer = new Headers(init?.headers).get('referer');
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    try {
      await safeFetch('https://1.1.1.1/resource', {
        referrer: 'https://example.com/page?q=1',
        referrerPolicy: 'origin',
      });
      expect(seenReferer).toBe('https://example.com/');

      seenReferer = null;
      await safeFetch('https://1.1.1.1/resource', {
        referrer: 'https://example.com/page?q=1',
        referrerPolicy: 'no-referrer',
      });
      expect(seenReferer).toBeNull();

      seenReferer = null;
      await safeFetch('https://1.1.1.1/resource', {
        referrer: 'https://user:pass@example.com/page?q=1#secret',
        referrerPolicy: 'unsafe-url',
      });
      expect(seenReferer).toBe('https://example.com/page?q=1');
      expect(seenReferer).not.toMatch(/user|pass|secret|#/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('rejects only-if-cached without same-origin mode', async () => {
    const original = globalThis.fetch;
    const fetchMock = mock(() => {
      throw new Error('fetch should not be called for only-if-cached without same-origin');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(
        safeFetch('https://1.1.1.1/', { cache: 'only-if-cached' })
      ).rejects.toThrow(/only-if-cached/i);
      await expect(
        safeFetch('https://1.1.1.1/', { cache: 'only-if-cached', mode: 'cors' })
      ).rejects.toThrow(/only-if-cached/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('rejects CONNECT before any network attempt', async () => {
    const original = globalThis.fetch;
    const fetchMock = mock(() => {
      throw new Error('fetch should not be called for CONNECT');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(
        safeFetch('https://1.1.1.1/', { method: 'CONNECT' })
      ).rejects.toThrow(/CONNECT/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('rejects TRACK before any network attempt', async () => {
    const original = globalThis.fetch;
    const fetchMock = mock(() => {
      throw new Error('fetch should not be called for TRACK');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(
        safeFetch('https://1.1.1.1/', { method: 'TRACK' })
      ).rejects.toThrow(/TRACK/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('rejects bodies on GET and HEAD before any network attempt', async () => {
    const original = globalThis.fetch;
    const fetchMock = mock(() => {
      throw new Error('fetch should not be called for GET/HEAD with body');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(
        safeFetch('https://1.1.1.1/', { method: 'GET', body: 'nope' })
      ).rejects.toThrow(/body/i);
      await expect(
        safeFetch('https://1.1.1.1/', { method: 'HEAD', body: 'nope' })
      ).rejects.toThrow(/body/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('rejects non-safelisted methods in no-cors mode before any network attempt', async () => {
    const original = globalThis.fetch;
    const fetchMock = mock(() => {
      throw new Error('fetch should not be called for no-cors non-safelisted methods');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      for (const method of ['PUT', 'PATCH', 'DELETE']) {
        await expect(
          safeFetch('https://1.1.1.1/', { method, mode: 'no-cors' })
        ).rejects.toThrow(/no-cors/i);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('allows GET/HEAD/POST in no-cors mode', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch;

    try {
      for (const method of ['GET', 'HEAD', 'POST']) {
        const response = await safeFetch('https://1.1.1.1/', {
          method,
          mode: 'no-cors',
          ...(method === 'POST' ? { body: 'x' } : {}),
        });
        expect(response.status).toBe(200);
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it('returns redirect responses that omit Location unchanged', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('missing location', {
        status: 302,
        statusText: 'Found',
      })) as typeof fetch;

    try {
      const response = await safeFetch('https://1.1.1.1/redirect');
      expect(response.status).toBe(302);
      expect(await response.text()).toBe('missing location');
      expect(response.headers.get('location')).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('does not retry ReadableStream bodies after the first transport failure', async () => {
    const original = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      throw new Error(`transport failure #${attempts}`);
    }) as typeof fetch;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('once'));
        controller.close();
      },
    });

    try {
      await expect(
        safeFetch('https://1.1.1.1/stream-once', {
          method: 'PUT',
          body: stream,
        })
      ).rejects.toThrow(/transport failure #1/);
      expect(attempts).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('strips caller-supplied Content-Length and Transfer-Encoding on Bun pinned path', async () => {
    const original = globalThis.fetch;
    let seenHeaders: Headers | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    try {
      await safeFetch('https://1.1.1.1/framing', {
        method: 'POST',
        body: 'hello',
        headers: {
          'Content-Length': '0',
          'Transfer-Encoding': 'chunked',
        },
      });
      expect(seenHeaders).not.toBeNull();
      expect(seenHeaders!.get('content-length')).toBeNull();
      expect(seenHeaders!.get('transfer-encoding')).toBeNull();
      expect(seenHeaders!.get('host')).toBe('1.1.1.1');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('sets Content-Length from Blob.size on the Node pinned path', async () => {
    let seenHeaders: https.RequestOptions['headers'];

    class FakeRequest extends EventEmitter {
      destroyed = false;
      write(_chunk: unknown) {
        return true;
      }
      end() {
        void Promise.resolve().then(() => {
          const res = new EventEmitter() as EventEmitter & {
            statusCode: number;
            statusMessage: string;
            headers: Record<string, string>;
            resume: () => void;
          };
          res.statusCode = 204;
          res.statusMessage = 'No Content';
          res.headers = {};
          res.resume = () => undefined;
          this.emit('response', res);
        });
      }
      destroy(err?: Error) {
        this.destroyed = true;
        if (err) this.emit('error', err);
        return this;
      }
    }

    // Pin DNS to a public address so local fake-IP resolvers cannot block the host.
    const lookupSpy = spyOn(dns, 'lookup').mockImplementation((async () => [
      { address: '1.1.1.1', family: 4 },
    ]) as typeof dns.lookup);

    // Spy the same default-export object url-safety imports.
    const requestSpy = spyOn(https, 'request').mockImplementation((
      options: unknown,
      cb?: (res: import('node:http').IncomingMessage) => void
    ) => {
      const opts =
        typeof options === 'object' && options !== null && !(options instanceof URL)
          ? (options as https.RequestOptions)
          : {};
      seenHeaders = opts.headers;
      const req = new FakeRequest();
      if (typeof cb === 'function') {
        req.on('response', cb);
      }
      return req as unknown as import('node:http').ClientRequest;
    });

    try {
      const payload = 'blob-body-bytes';
      const blob = new Blob([payload], { type: 'text/plain' });
      const response = await safeFetch('https://example.com/blob-upload', {
        method: 'POST',
        body: blob,
        headers: {
          // Caller framing must be ignored; length comes from Blob.size.
          'Content-Length': '0',
          'Transfer-Encoding': 'chunked',
        },
      });
      expect(response.status).toBe(204);
      expect(seenHeaders).toBeDefined();
      const headers = new Headers(
        Object.entries(seenHeaders ?? {}).flatMap(([key, value]) => {
          if (value === undefined) return [];
          if (Array.isArray(value)) return value.map((v) => [key, v] as [string, string]);
          return [[key, String(value)] as [string, string]];
        })
      );
      expect(headers.get('content-length')).toBe(String(blob.size));
      expect(headers.get('transfer-encoding')).toBeNull();
      expect(headers.get('host')).toBe('example.com');
      expect(headers.get('content-type')).toBe(blob.type || 'text/plain');
      expect(requestSpy).toHaveBeenCalled();
    } finally {
      requestSpy.mockRestore();
      lookupSpy.mockRestore();
    }
  });
});

describe('HTTP tools SSRF guards (no network I/O)', () => {
  it('http_get blocks metadata URL without calling fetch', async () => {
    const fetchMock = mock(() => {
      throw new Error('fetch should not be called for blocked URLs');
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(
        httpGetTool.execute({ url: 'https://169.254.169.254/latest/meta-data/' })
      ).rejects.toThrow(/blocked/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('http_post blocks private IP without calling fetch', async () => {
    const fetchMock = mock(() => {
      throw new Error('fetch should not be called for blocked URLs');
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(
        httpPostTool.execute({ url: 'https://192.168.0.1/api', body: { a: 1 } })
      ).rejects.toThrow(/blocked/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('fetch_json blocks http scheme without calling fetch', async () => {
    const fetchMock = mock(() => {
      throw new Error('fetch should not be called for blocked URLs');
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(fetchJsonTool.execute({ url: 'http://example.com/data.json' })).rejects.toThrow(
        /http:/i
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('http_get re-validates redirect Location and does not follow to private IP', async () => {
    let callCount = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      callCount += 1;
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (callCount === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://127.0.0.1/admin' },
        });
      }
      throw new Error(`Unexpected fetch to ${href}`);
    }) as typeof fetch;

    try {
      // Literal public IP avoids DNS; redirect target must still be blocked pre-fetch
      await expect(
        httpGetTool.execute({ url: 'https://1.1.1.1/redirect', timeout: 5000 })
      ).rejects.toThrow(/blocked/i);
      expect(callCount).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
