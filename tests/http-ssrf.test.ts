import { describe, expect, it, mock } from 'bun:test';
import { assertSafeHttpUrl, getSafeFetchUrl, safeFetch } from '../src/utils/url-safety.js';
import { httpGetTool, httpPostTool, fetchJsonTool } from '../src/tools/http.js';

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
