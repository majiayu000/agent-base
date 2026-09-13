import { defineTool } from '../core/tool-executor.js';
import { createAbortError, mergeAbortSignals, throwIfAborted } from '../utils/abort.js';

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
  description: 'Make an HTTP GET request to fetch data from a URL. Returns status, headers, and response body.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch (must be a valid HTTP/HTTPS URL)',
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
  execute: async ({ url, headers = {}, timeout = 30000 }, signal) => {
    throwIfAborted(signal);

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(createAbortError('Request timed out')), timeout);
    const { signal: requestSignal, dispose: disposeMerged } = mergeAbortSignals(
      timeoutController.signal,
      signal
    );

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'AgentBase/1.0',
          ...headers,
        },
        signal: requestSignal,
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
        url: response.url,
        ok: response.ok,
      };
    } finally {
      clearTimeout(timeoutId);
      disposeMerged();
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
  description: 'Make an HTTP POST request to send data to a URL. Supports JSON, form data, and plain text.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to send the request to',
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
  execute: async ({ url, body, headers = {}, contentType = 'json', timeout = 30000 }, signal) => {
    throwIfAborted(signal);

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(createAbortError('Request timed out')), timeout);
    const { signal: requestSignal, dispose: disposeMerged } = mergeAbortSignals(
      timeoutController.signal,
      signal
    );

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
      const response = await fetch(url, {
        method: 'POST',
        headers: requestHeaders,
        body: requestBody,
        signal: requestSignal,
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
        url: response.url,
        ok: response.ok,
      };
    } finally {
      clearTimeout(timeoutId);
      disposeMerged();
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
  description: 'Fetch JSON data from a URL and parse it. Simpler than http_get for JSON APIs.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch JSON from',
      },
      headers: {
        type: 'object',
        description: 'Optional HTTP headers',
      },
    },
    required: ['url'],
  },
  execute: async ({ url, headers = {} }, signal) => {
    throwIfAborted(signal);

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'AgentBase/1.0',
        ...headers,
      },
      signal,
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
