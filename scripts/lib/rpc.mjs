// Read-only JSON-RPC client for the harness scripts: retry with backoff on rate limits (-32005 / HTTP 429),
// then fall back to the next endpoint. Only read methods are ever called; nothing here signs or sends.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const TESTNET_CHAIN_ID = 998;
export const MAINNET_CHAIN_ID = 999;
const READ_METHODS = new Set(['eth_chainId', 'eth_getCode', 'eth_getBalance', 'eth_call', 'eth_blockNumber']);

// Fallback endpoints are taken from the engine's list (engine/numera_engine/rpc.py, `*_TESTNET_RPC = "..."`)
// so the URL lives in one place.
export function engineTestnetRpcs(root) {
  const f = path.join(root, 'engine', 'numera_engine', 'rpc.py');
  if (!existsSync(f)) return [];
  const urls = [];
  for (const m of readFileSync(f, 'utf8').matchAll(/^[A-Z_]*TESTNET_RPC\s*=\s*"(https?:\/\/[^"]+)"/gm)) urls.push(m[1]);
  return urls;
}

export function isRateLimit(status, body) {
  if (status === 429) return true;
  const e = body && typeof body === 'object' ? body.error : null;
  return !!e && (e.code === -32005 || /rate limit/i.test(String(e.message ?? '')));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RpcError extends Error {
  constructor(code, message) {
    super(`rpc error ${code}: ${message}`);
    this.code = code;
  }
}

// One POST. -> { status, body, ms }. Throws on transport failure or timeout.
async function post(url, payload, timeoutMs, fetchImpl) {
  const t0 = Date.now();
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body, ms: Date.now() - t0 };
}

// Client over an ordered endpoint list. call(method, params) -> { result, url }.
export function makeClient(urls, { retries = 3, baseDelayMs = 500, timeoutMs = 8000, fetchImpl = fetch, sleepImpl = sleep } = {}) {
  const list = [...new Set(urls.filter(Boolean))];
  let id = 0;
  const answeredBy = new Map(); // url -> count
  async function call(method, params = []) {
    if (!READ_METHODS.has(method)) throw new Error(`refusing non-read RPC method ${method}`);
    let lastErr = null;
    for (const url of list) {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const { status, body } = await post(url, { jsonrpc: '2.0', id: ++id, method, params }, timeoutMs, fetchImpl);
          if (isRateLimit(status, body)) {
            lastErr = new Error(`${host(url)} rate-limited`);
            if (attempt < retries) await sleepImpl(baseDelayMs * 2 ** attempt);
            continue;
          }
          if (status >= 500 || !body) {
            lastErr = new Error(`${host(url)} HTTP ${status}`);
            if (attempt < retries) await sleepImpl(baseDelayMs * 2 ** attempt);
            continue;
          }
          if (body.error) throw new RpcError(body.error.code, body.error.message);
          answeredBy.set(url, (answeredBy.get(url) ?? 0) + 1);
          return { result: body.result, url };
        } catch (e) {
          if (e instanceof RpcError) throw e;
          lastErr = new Error(`${host(url)} ${e.name === 'TimeoutError' ? 'timeout' : e.message}`);
          if (attempt < retries) await sleepImpl(baseDelayMs * 2 ** attempt);
        }
      }
    }
    throw lastErr ?? new Error('no RPC endpoint configured');
  }
  return { call, answeredBy, urls: list };
}

// Single raw probe without retry (rate-limit probe). -> { ok, limited, ms, error }
export async function probe(url, method = 'eth_blockNumber', { timeoutMs = 8000, fetchImpl = fetch } = {}) {
  if (!READ_METHODS.has(method)) throw new Error(`refusing non-read RPC method ${method}`);
  try {
    const { status, body, ms } = await post(url, { jsonrpc: '2.0', id: 1, method, params: [] }, timeoutMs, fetchImpl);
    if (isRateLimit(status, body)) return { ok: false, limited: true, ms };
    if (body?.error || status !== 200) return { ok: false, limited: false, ms, error: body?.error?.message ?? `HTTP ${status}` };
    return { ok: true, limited: false, ms, result: body.result };
  } catch (e) {
    return { ok: false, limited: false, ms: 0, error: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }
}

export function host(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// Hosts that serve HyperEVM mainnet. A configured RPC on one of these is refused without a network call.
export function looksLikeMainnetRpc(url) {
  const h = host(url ?? '').toLowerCase();
  return h === 'rpc.hyperliquid.xyz' || h === 'api.hyperliquid.xyz' || /\/hyperevm\/mainnet\b/i.test(url ?? '');
}
