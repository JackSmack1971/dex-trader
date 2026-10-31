export type RpcMethod = 'eth_chainId' | 'eth_getBlockByNumber' | 'eth_getBlockByHash' | 'eth_getCode' | 'eth_getStorageAt' | 'eth_getBalance' | 'eth_call';
const METHODS = new Set<RpcMethod>(['eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getCode', 'eth_getStorageAt', 'eth_getBalance', 'eth_call']);

export type RpcErrorCode = 'RPC_CONFIG_INVALID' | 'RPC_METHOD_UNSUPPORTED' | 'RPC_TIMEOUT' | 'RPC_TRANSPORT' | 'RPC_HTTP_STATUS' | 'RPC_RESPONSE_TOO_LARGE' | 'RPC_MALFORMED_RESPONSE' | 'RPC_REMOTE_ERROR';
export class RpcClientError extends Error {
  constructor(readonly code: RpcErrorCode) { super(code); this.name = 'RpcClientError'; }
}

export interface RpcClientOptions {
  readonly endpoint: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly allowLoopbackForTests?: boolean;
  readonly fetchImpl?: typeof fetch;
}

export class RpcClient {
  readonly #url: URL;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #fetch: typeof fetch;
  #nextId = 1;

  constructor(options: RpcClientOptions) {
    try { this.#url = new URL(options.endpoint); }
    catch { throw new RpcClientError('RPC_CONFIG_INVALID'); }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(this.#url.hostname);
    if ((this.#url.protocol !== 'https:' && !(options.allowLoopbackForTests === true && this.#url.protocol === 'http:' && loopback)) ||
      this.#url.username || this.#url.password || this.#url.hash) throw new RpcClientError('RPC_CONFIG_INVALID');
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#maxBytes = options.maxResponseBytes ?? 1_048_576;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0 || !Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1) throw new RpcClientError('RPC_CONFIG_INVALID');
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async request<T = unknown>(method: string, params: readonly unknown[] = []): Promise<T> {
    if (!METHODS.has(method as RpcMethod)) throw new RpcClientError('RPC_METHOD_UNSUPPORTED');
    if (!Array.isArray(params)) throw new RpcClientError('RPC_CONFIG_INVALID');
    const id = this.#nextId++;
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') throw new RpcClientError('RPC_TIMEOUT');
      if (error instanceof TypeError && /redirect/i.test(error.message)) throw new RpcClientError('RPC_TRANSPORT');
      throw new RpcClientError('RPC_TRANSPORT');
    }
    if (response.status < 200 || response.status >= 300) throw new RpcClientError('RPC_HTTP_STATUS');
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new RpcClientError('RPC_MALFORMED_RESPONSE');
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > this.#maxBytes)) throw new RpcClientError('RPC_RESPONSE_TOO_LARGE');
    let bytes: Uint8Array;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new RpcClientError('RPC_MALFORMED_RESPONSE');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.#maxBytes) { await reader.cancel(); throw new RpcClientError('RPC_RESPONSE_TOO_LARGE'); }
        chunks.push(value);
      }
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    } catch (error) {
      if (error instanceof RpcClientError) throw error;
      throw new RpcClientError('RPC_TRANSPORT');
    }
    let body: unknown;
    try {
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      rejectDuplicateKeys(source);
      body = JSON.parse(source);
    } catch { throw new RpcClientError('RPC_MALFORMED_RESPONSE'); }
    if (!isRecord(body) || body.jsonrpc !== '2.0' || body.id !== id) throw new RpcClientError('RPC_MALFORMED_RESPONSE');
    const keys = Object.keys(body).sort().join(',');
    if (Object.hasOwn(body, 'result')) {
      if (keys !== 'id,jsonrpc,result') throw new RpcClientError('RPC_MALFORMED_RESPONSE');
    } else if (Object.hasOwn(body, 'error')) {
      if (keys !== 'error,id,jsonrpc' || !isRecord(body.error) || !Number.isSafeInteger(body.error.code) || typeof body.error.message !== 'string' ||
        !['code,message', 'code,data,message'].includes(Object.keys(body.error).sort().join(','))) throw new RpcClientError('RPC_MALFORMED_RESPONSE');
      throw new RpcClientError('RPC_REMOTE_ERROR');
    } else throw new RpcClientError('RPC_MALFORMED_RESPONSE');
    return body.result as T;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function rejectDuplicateKeys(source: string): void {
  let index = 0;
  const whitespace = () => { while (/\s/.test(source[index] ?? '')) index++; };
  const string = (): string => {
    const start = index++;
    while (index < source.length) {
      if (source[index] === '\\') { index += 2; continue; }
      if (source[index++] === '"') return JSON.parse(source.slice(start, index)) as string;
    }
    throw new Error('INVALID_JSON');
  };
  const value = (): void => {
    whitespace();
    if (source[index] === '{') {
      index++;
      whitespace();
      const keys = new Set<string>();
      if (source[index] === '}') { index++; return; }
      for (;;) {
        whitespace();
        if (source[index] !== '"') throw new Error('INVALID_JSON');
        const key = string();
        if (keys.has(key)) throw new Error('DUPLICATE_JSON_KEY');
        keys.add(key);
        whitespace();
        if (source[index++] !== ':') throw new Error('INVALID_JSON');
        value();
        whitespace();
        const delimiter = source[index++];
        if (delimiter === '}') return;
        if (delimiter !== ',') throw new Error('INVALID_JSON');
      }
    }
    if (source[index] === '[') {
      index++;
      whitespace();
      if (source[index] === ']') { index++; return; }
      for (;;) {
        value();
        whitespace();
        const delimiter = source[index++];
        if (delimiter === ']') return;
        if (delimiter !== ',') throw new Error('INVALID_JSON');
      }
    }
    if (source[index] === '"') { string(); return; }
    const start = index;
    while (index < source.length && !/[\s,\]}]/.test(source[index]!)) index++;
    if (index === start) throw new Error('INVALID_JSON');
  };
  value();
  whitespace();
  if (index !== source.length) throw new Error('INVALID_JSON');
}

export function validateRpcAddress(address: unknown): address is `0x${string}` {
  return typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address);
}
