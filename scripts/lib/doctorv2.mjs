// CoverPool v2 checks for scripts/doctor.mjs (deployments/testnet-v2.json). Read-only: eth_getCode and eth_call
// through the caller's client (scripts/lib/rpc.mjs refuses any other method). Pure helpers so node --test can
// drive them with a fake client.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// 4-byte selectors of the CoverPool view functions (contracts/src/CoverPool.sol), from `cast sig`:
//   paused()      -> 0x5c975abb (OpenZeppelin Pausable)
//   totalAssets() -> 0x01e1d114 (ERC-4626, CoverPool.sol:352)
//   coverCount()  -> 0xfeb0b8f5 (`uint256 public coverCount`, CoverPool.sol:66)
export const V2_SEL = { paused: '0x5c975abb', totalAssets: '0x01e1d114', coverCount: '0xfeb0b8f5' };

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const TESTNET = 998;
const MAINNET = 999;

// -> { missing: true } | { error } | { chainId, pools: [{ name, addr, chainId }], bad: [{ name, why }] }
export function loadV2(file) {
  if (!existsSync(file)) return { missing: true };
  let j;
  try {
    j = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { error: `cannot parse ${path.basename(file)}: ${e.message}` };
  }
  const pools = [];
  const bad = [];
  for (const [name, p] of Object.entries(j?.pools ?? {})) {
    if (ADDR.test(p?.pool ?? '')) pools.push({ name, addr: p.pool, chainId: Number(p.chainId ?? j.chainId) });
    else bad.push({ name, why: 'no 0x pool address' });
  }
  return { chainId: Number(j?.chainId), pools, bad };
}

// [level, check, detail] for the file-level checks (no network).
export function v2FileLines(v2, file) {
  const base = path.basename(file);
  if (v2.missing) return [['WARN', 'v2 deployments', `${base} not found; v2 pool checks skipped`]];
  if (v2.error) return [['FAIL', 'v2 deployments', v2.error]];
  const out = [];
  const chainLine = (label, cid) => {
    if (cid === MAINNET) return ['FAIL', label, `MAINNET 999 in ${base}. Numera is testnet only.`];
    if (cid !== TESTNET) return ['FAIL', label, `${Number.isNaN(cid) ? 'missing' : cid}, expected 998`];
    return null;
  };
  const top = chainLine('v2 deployments chainId', v2.chainId);
  out.push(top ?? ['OK', 'v2 deployments chainId', `998 (${base}, pools: ${v2.pools.map((p) => p.name).join(', ') || 'none'})`]);
  for (const p of v2.pools) {
    const l = p.chainId !== v2.chainId ? chainLine(`v2 pools.${p.name} chainId`, p.chainId) : null;
    if (l) out.push(l);
  }
  for (const b of v2.bad) out.push(['FAIL', `v2 pools.${b.name}`, b.why]);
  if (!v2.pools.length && !v2.bad.length) out.push(['WARN', 'v2 pools', `no pools in ${base}`]);
  return out;
}

export function decodeUint(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{64}/.test(hex)) throw new Error(`bad return data ${String(hex).slice(0, 20)}`);
  return BigInt(hex.slice(0, 66));
}

export function decodeBool(hex) {
  const v = decodeUint(hex);
  if (v > 1n) throw new Error(`not a bool: ${v}`);
  return v === 1n;
}

export function fmtUsdc6(v) {
  const s = v.toString().padStart(7, '0');
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}

// On-chain checks for each pool: code, paused() false, totalAssets() and coverCount() readable.
// Each check catches its own RPC failure (FAIL line) and the next check still runs.
// report(level, check, detail); host(url) -> printable host.
export async function checkV2Pools(client, pools, report, host = (u) => u) {
  for (const p of pools) {
    const label = (what) => `v2 ${what} pools.${p.name}`;
    try {
      const { result, url } = await client.call('eth_getCode', [p.addr, 'latest']);
      const bytes = typeof result === 'string' && result.startsWith('0x') ? (result.length - 2) / 2 : 0;
      report(bytes > 0 ? 'OK' : 'FAIL', label('code'), `${p.addr} ${bytes > 0 ? `${bytes} bytes` : 'NO CODE'} (via ${host(url)})`);
    } catch (e) {
      report('FAIL', label('code'), `${p.addr}: ${e.message}`);
    }
    const view = async (what, fn) => {
      try {
        const { result, url } = await client.call('eth_call', [{ to: p.addr, data: V2_SEL[what] }, 'latest']);
        const [level, detail] = fn(result);
        report(level, label(what), `${detail} (via ${host(url)})`);
      } catch (e) {
        report('FAIL', label(what), e.message);
      }
    };
    await view('paused', (r) => (decodeBool(r) ? ['FAIL', 'true (buyCover and deposits blocked; owner must unpause)'] : ['OK', 'false']));
    await view('totalAssets', (r) => ['OK', `${fmtUsdc6(decodeUint(r))} USDC`]);
    await view('coverCount', (r) => ['OK', `${decodeUint(r)}`]);
  }
}
