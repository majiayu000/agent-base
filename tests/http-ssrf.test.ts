import { describe, expect, it, mock } from 'bun:test';
import { assertSafeHttpUrl } from '../src/utils/url-safety.js';
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

  it('rejects IPv6 loopback and link-local', async () => {
    await expect(assertSafeHttpUrl('https://[::1]/')).rejects.toThrow(/blocked/i);
    await expect(assertSafeHttpUrl('https://[fe80::1]/')).rejects.toThrow(/blocked/i);
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
