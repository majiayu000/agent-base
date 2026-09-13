import { defineTool } from '../core/tool-executor.js';
import { safeFetch } from '../utils/url-safety.js';

// ============================================================================
// HTTP Request Tools
// ============================================================================

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  url: string;
  ok: boolean;
}

/**
 * HTTP GET request tool
 */
export const httpGetTool = defineTool<
  { url: string; headers?: Record<string, string>; timeout?: number },
  HttpResponse
>({
  name: 'http_get',
  description:
    'Make an HTTPS GET request to fetch data from a URL. Blocks private/link-local/metadata targets (SSRF protection). Returns status, headers, and response body.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch (https only; private/link-local hosts are blocked)',
      },
      headers: {
        type: 'object',
        description: 'Optional HTTP headers to include in the request',
      },
      timeout: {
        type: 'number',
        description: 'Request timeout in milliseconds (default: 30000)',
      },
    },
    required: ['url'],
  },
  execute: async ({ url, headers = {}, timeout = 30000 }) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await safeFetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'AgentBase/1.0',
          ...headers,
        },
        signal: controller.signal,
      });

      const body = await response.text();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      return {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: body.slice(0, 50000), // Limit body size
        url: response.url || url,
        ok: response.ok,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  },
});

/**
 * HTTP POST request tool
 */
export const httpPostTool = defineTool<
  {
    url: string;
    body?: string | Record<string, unknown>;
    headers?: Record<string, string>;
    contentType?: 'json' | 'form' | 'text';
    timeout?: number;
  },
  HttpResponse
>({
  name: 'http_post',
  description:
    'Make an HTTPS POST request to send data to a URL. Blocks private/link-local/metadata targets (SSRF protection). Supports JSON, form data, and plain text.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to send the request to (https only; private/link-local hosts are blocked)',
      },
      body: {
        type: 'string',
        description: 'The request body (string or object for JSON)',
      },
      headers: {
        type: 'object',
        description: 'Optional HTTP headers',
      },
      contentType: {
        type: 'string',
        description: 'Content type: "json", "form", or "text" (default: "json")',
        enum: ['json', 'form', 'text'],
      },
      timeout: {
        type: 'number',
        description: 'Request timeout in milliseconds (default: 30000)',
      },
    },
    required: ['url'],
  },
  execute: async ({ url, body, headers = {}, contentType = 'json', timeout = 30000 }) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    let requestBody: string | undefined;
    const requestHeaders: Record<string, string> = {
      'User-Agent': 'AgentBase/1.0',
      ...headers,
    };

    if (body !== undefined) {
      switch (contentType) {
        case 'json':
          requestBody = typeof body === 'string' ? body : JSON.stringify(body);
          requestHeaders['Content-Type'] = 'application/json';
          break;
        case 'form':
          if (typeof body === 'object') {
            requestBody = new URLSearchParams(body as Record<string, string>).toString();
          } else {
            requestBody = body;
          }
          requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
          break;
        case 'text':
          requestBody = typeof body === 'string' ? body : JSON.stringify(body);
          requestHeaders['Content-Type'] = 'text/plain';
          break;
      }
    }

    try {
      const response = await safeFetch(url, {
        method: 'POST',
        headers: requestHeaders,
        body: requestBody,
        signal: controller.signal,
      });

      const responseBody = await response.text();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      return {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: responseBody.slice(0, 50000),
        url: response.url || url,
        ok: response.ok,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  },
});

/**
 * Fetch and parse JSON from URL
 */
export const fetchJsonTool = defineTool<
  { url: string; headers?: Record<string, string> },
  { data: unknown; status: number }
>({
  name: 'fetch_json',
  description:
    'Fetch JSON data from an HTTPS URL and parse it. Blocks private/link-local/metadata targets (SSRF protection). Simpler than http_get for JSON APIs.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch JSON from (https only; private/link-local hosts are blocked)',
      },
      headers: {
        type: 'object',
        description: 'Optional HTTP headers',
      },
    },
    required: ['url'],
  },
  execute: async ({ url, headers = {} }) => {
    const response = await safeFetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'AgentBase/1.0',
        ...headers,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    return { data, status: response.status };
  },
});

/**
 * All HTTP tools
 */
export const httpTools = [httpGetTool, httpPostTool, fetchJsonTool];
