import { createHmac } from 'node:crypto';
import { canonicalJson, redactString, sha256Hex } from '@orderrescue/domain';

export interface SignedClientOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  recvWindowMs: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export interface RawResponse {
  status: number;
  bodyText: string;
  json: unknown;
  parsed: boolean;
  headers: Record<string, string>;
}

export class TransportFailure extends Error {
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = 'TransportFailure';
    this.detail = detail;
  }
}

/**
 * A thin signed client. Deliberately does no retrying of its own: a retry
 * hidden inside the transport is exactly the duplicate this product exists to
 * prevent, so the decision to send anything again belongs to the domain layer.
 */
export class BinanceSignedClient {
  private readonly options: SignedClientOptions;
  private readonly doFetch: typeof fetch;

  constructor(options: SignedClientOptions) {
    this.options = options;
    this.doFetch = options.fetchImpl ?? fetch;
  }

  /** Digest of a request with credentials and signature removed. */
  static requestDigest(method: string, path: string, params: Record<string, string>): string {
    const safe: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key === 'signature' || key === 'timestamp' || key.toLowerCase().includes('key')) continue;
      safe[key] = value;
    }
    return sha256Hex(canonicalJson({ method, path, params: safe }));
  }

  async publicRequest(method: 'GET', path: string, params: Record<string, string> = {}): Promise<RawResponse> {
    const query = new URLSearchParams(params).toString();
    const url = `${this.options.baseUrl}${path}${query ? `?${query}` : ''}`;
    return this.send(method, url, {});
  }

  async signedRequest(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, string> = {},
  ): Promise<RawResponse> {
    const withTiming: Record<string, string> = {
      ...params,
      recvWindow: String(this.options.recvWindowMs),
      timestamp: String(Date.now()),
    };
    const query = new URLSearchParams(withTiming).toString();
    const signature = createHmac('sha256', this.options.apiSecret).update(query).digest('hex');
    const url = `${this.options.baseUrl}${path}?${query}&signature=${signature}`;
    return this.send(method, url, { 'X-MBX-APIKEY': this.options.apiKey });
  }

  private async send(method: string, url: string, headers: Record<string, string>): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.doFetch(url, {
        method,
        headers: { ...headers, Accept: 'application/json' },
        signal: controller.signal,
      });
      const bodyText = await response.text();
      let json: unknown = null;
      let parsed = false;
      try {
        json = JSON.parse(bodyText);
        parsed = true;
      } catch {
        parsed = false;
      }
      const responseHeaders: Record<string, string> = {};
      for (const name of ['x-mbx-used-weight-1m', 'retry-after', 'content-type']) {
        const value = response.headers.get(name);
        if (value !== null) responseHeaders[name] = value;
      }
      return { status: response.status, bodyText, json, parsed, headers: responseHeaders };
    } catch (error) {
      const detail = redactString(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      if (controller.signal.aborted) {
        throw new TransportFailure('request timed out before a response was received', detail);
      }
      throw new TransportFailure('transport failed before a response was received', detail);
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface VenueErrorEnvelope {
  code: number;
  msg: string;
}

/**
 * Only a well-formed `{code, msg}` body counts as the venue speaking. An HTML
 * error page from a proxy is not the exchange saying "I rejected your order";
 * it is noise, and noise must stay ambiguous.
 */
export function readVenueError(response: RawResponse): VenueErrorEnvelope | null {
  if (!response.parsed || response.json === null || typeof response.json !== 'object') return null;
  const body = response.json as Record<string, unknown>;
  if (typeof body.code !== 'number' || typeof body.msg !== 'string') return null;
  return { code: body.code, msg: body.msg };
}

export function digestResponse(response: RawResponse): string {
  return sha256Hex(canonicalJson({ status: response.status, body: redactString(response.bodyText) }));
}
