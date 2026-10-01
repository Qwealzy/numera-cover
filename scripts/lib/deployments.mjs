// deployments/<env>.json helpers.
const ADDR = /^0x[0-9a-fA-F]{40}$/;

// Keys whose address is an externally owned account (balance check), not a contract (code check).
const EOA_KEYS = new Set(['deployer', 'quoteSigner', 'keeper']);
// Sub-trees that hold history, tx records or superseded deployments, not the live contract set.
const SKIP_KEYS = new Set(['previous', 'e2e', 'seed', 'verification', 'txs']);

export function collectAddresses(dep) {
  const contracts = [];
  const eoas = [];
  const walk = (node, p) => {
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) if (!SKIP_KEYS.has(k)) walk(v, p ? `${p}.${k}` : k);
    } else if (typeof node === 'string' && ADDR.test(node)) {
      const key = p.split('.').pop();
      (EOA_KEYS.has(key) && !p.includes('.') ? eoas : contracts).push({ path: p, addr: node });
    }
  };
  walk(dep, '');
  return { contracts, eoas };
}
