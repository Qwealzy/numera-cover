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

// Error text that never contains the URL (provider API keys live in URL paths). fetch's own messages quote the
// URL ("Failed to parse URL from <url>"), so the URL is cut out, and an unparsable URL is reported as such.
export function redact(message, url) {
  let m = String(message ?? '');
  if (url && !isParsableUrl(url)) return 'invalid URL';
  if (url) m = m.split(url).join('<url>');
  return m;
}

function isParsableUrl(url) {
  try {
    return !!new URL(url).host;
  } catch {
    return false;
  }
}

// Client over an ordered endpoint list. call(method, params) -> { result, url }.
// Retries back off exponentially with +/-20 % jitter; maxWaitMs caps the total sleep per endpoint.
export function makeClient(
  urls,
  { retries = 3, baseDelayMs = 500, maxWaitMs = Infinity, timeoutMs = 8000, fetchImpl = fetch, sleepImpl = sleep, rand = Math.random } = {},
) {
  const list = [...new Set(urls.filter(Boolean))];
  let id = 0;
  const answeredBy = new Map(); // url -> count
  async function call(method, params = []) {
    if (!READ_METHODS.has(method)) throw new Error(`refusing non-read RPC method ${method}`);
    let lastErr = null;
    for (const url of list) {
      if (!isParsableUrl(url)) {
        lastErr = new Error('not a parsable URL (value not shown)');
        continue;
      }
      let waited = 0;
      const backoff = async (attempt) => {
        if (attempt >= retries) return;
        const ms = Math.min(baseDelayMs * 2 ** attempt * (1 + 0.2 * (2 * rand() - 1)), maxWaitMs - waited);
        if (ms > 0) {
          waited += ms;
          await sleepImpl(ms);
        }
      };
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const { status, body } = await post(url, { jsonrpc: '2.0', id: ++id, method, params }, timeoutMs, fetchImpl);
          if (isRateLimit(status, body)) {
            lastErr = new Error(`${host(url)} rate-limited`);
            await backoff(attempt);
            continue;
          }
          if (status >= 500 || !body) {
            lastErr = new Error(`${host(url)} HTTP ${status}`);
            await backoff(attempt);
            continue;
          }
          if (body.error) throw new RpcError(body.error.code, redact(body.error.message, url));
          answeredBy.set(url, (answeredBy.get(url) ?? 0) + 1);
          return { result: body.result, url };
        } catch (e) {
          if (e instanceof RpcError) throw e;
          lastErr = new Error(`${host(url)} ${e.name === 'TimeoutError' ? 'timeout' : redact(e.message, url)}`);
          await backoff(attempt);
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
    if (body?.error || status !== 200) return { ok: false, limited: false, ms, error: redact(body?.error?.message ?? `HTTP ${status}`, url) };
    return { ok: true, limited: false, ms, result: body.result };
  } catch (e) {
    return { ok: false, limited: false, ms: 0, error: e.name === 'TimeoutError' ? 'timeout' : redact(e.message, url) };
  }
}

// Host part only (no path, no user:key). Never echoes an unparsable URL.
export function host(url) {
  try {
    return new URL(url).host || '<invalid URL>';
  } catch {
    return '<invalid URL>';
  }
}

// Hosts that serve HyperEVM mainnet. A configured RPC on one of these is refused without a network call.
export function looksLikeMainnetRpc(url) {
  const h = host(url ?? '').toLowerCase();
  return h === 'rpc.hyperliquid.xyz' || h === 'api.hyperliquid.xyz' || /\/hyperevm\/mainnet\b/i.test(url ?? '');
}
