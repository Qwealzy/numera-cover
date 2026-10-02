"""Read deployments/<env>.json (written by the contracts deploy scripts; read-only for the engine).

Shape used (see deployments/testnet.json): {"chainId", "rpc", "keeper", "pools": {name: {"pool",
"priceSource", "txs": {"pool": <deploy tx hash>, ...}}}, "perps": {coin: index}}. Unknown keys are ignored.

CoverPool v2 pools (ARCHITECTURE §5.9) are listed in a sibling file, deployments/<env>-v2.json, written by
scripts/deploy-v2.mjs: {"contract": "CoverPool v2", "pools": {mode: {"chainId", "pool", "priceSource",
"config": {"limits", "perps": {coin: {"index", "allowed"}}, ...},
"txs": [{"name", "function", "hash"}, ...]}}}.
``load(path)`` merges that sibling when it exists: its pools are appended as ``<mode>-v2`` with
``version = "v2"``; the perp allowlist stays the main file's (the pool's own ``perpAllowed`` is checked on
chain). A v2 pool whose own ``chainId`` differs from the main file's is skipped.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
V2_CONTRACT = "CoverPool v2"
log = logging.getLogger("numera.deployments")


def default_path(env: str) -> Path:
    return REPO_ROOT / "deployments" / f"{env}.json"


def v2_sibling(path: str | Path) -> Path:
    """deployments/<env>.json -> deployments/<env>-v2.json (the v2 deploy script's output)."""
    p = Path(path)
    return p.with_name(f"{p.stem}-v2{p.suffix}")


@dataclass(frozen=True)
class PoolInfo:
    name: str
    pool: str  # lower-case hex
    price_source: str | None
    deploy_tx: str | None
    version: str | None = None  # "v2" when the deployments file says so; None = unknown (probe on chain)


@dataclass(frozen=True)
class Deployment:
    chain_id: int | None
    rpc: str | None
    pools: tuple[PoolInfo, ...]
    perps: dict[str, int]
    keeper: str | None = None  # keeper EOA address (public), for the balance check in --dry-run

    def find(self, address: str) -> PoolInfo | None:
        a = address.lower()
        return next((p for p in self.pools if p.pool == a), None)

    def coin_of(self, perp_index: int) -> str | None:
        return next((c for c, i in self.perps.items() if i == perp_index), None)

    def version_of(self, address: str) -> str | None:
        info = self.find(address)
        return info.version if info else None


def _deploy_tx(txs: Any) -> str | None:
    """v1: {"pool": hash}; v2 (deploy-v2.mjs): [{"name": "CoverPool", "function": "create", "hash"}, ...]."""
    if isinstance(txs, dict):
        return txs.get("pool")
    if isinstance(txs, list):
        for t in txs:
            if isinstance(t, dict) and t.get("name") == "CoverPool" and t.get("function") in ("create", None):
                return t.get("hash")
    return None


def _is_v2_pool(blob: dict[str, Any], p: dict[str, Any]) -> bool:
    if str(p.get("version", "")).lower() == "v2":
        return True
    if blob.get("contract") == V2_CONTRACT:
        return True
    cfg = p.get("config")
    return isinstance(cfg, dict) and isinstance(cfg.get("limits"), dict)


def _v2_perps(pools: dict[str, Any]) -> dict[str, int]:
    """Perps listed in a v2 file's pool configs ({coin: {"index", "allowed"}}), for a v2-only file."""
    out: dict[str, int] = {}
    for p in pools.values():
        perps = (p.get("config") or {}).get("perps") if isinstance(p, dict) else None
        for coin, v in (perps or {}).items():
            if isinstance(v, dict) and "index" in v:
                out.setdefault(str(coin), int(v["index"]))
    return out


def parse(blob: dict[str, Any]) -> Deployment:
    pools = []
    raw_pools = blob.get("pools") or {}
    for name, p in raw_pools.items():
        if not isinstance(p, dict) or "pool" not in p:
            continue
        ps = p.get("priceSource")
        version = "v2" if _is_v2_pool(blob, p) else None
        src = ps.lower() if ps else None
        pools.append(PoolInfo(name, str(p["pool"]).lower(), src, _deploy_tx(p.get("txs")), version))
    perps = {str(k): int(v) for k, v in (blob.get("perps") or {}).items()}
    if not perps and blob.get("contract") == V2_CONTRACT:
        perps = _v2_perps(raw_pools)
    chain = blob.get("chainId")
    if blob.get("contract") == V2_CONTRACT:  # deploy-v2.mjs puts the real chain on each pool (dry run: 31337)
        chains = {int(p["chainId"]) for p in raw_pools.values() if isinstance(p, dict) and "chainId" in p}
        if len(chains) == 1:
            chain = chains.pop()
    return Deployment(
        chain_id=int(chain) if chain is not None else None,
        rpc=blob.get("rpc"),
        pools=tuple(pools),
        perps=perps,
        keeper=str(blob["keeper"]) if blob.get("keeper") else None,
    )


def merge_v2(main: Deployment, blob: dict[str, Any]) -> Deployment:
    """Append the v2 file's pools to ``main`` as ``<name>-v2`` (version "v2"); skip other-chain pools."""
    extra = []
    known = {p.pool for p in main.pools}
    for name, p in (blob.get("pools") or {}).items():
        if not isinstance(p, dict) or "pool" not in p:
            continue
        chain = p.get("chainId", blob.get("chainId"))
        if main.chain_id is not None and chain is not None and int(chain) != main.chain_id:
            log.warning("[deployments] v2 pool %s is on chain %s, the main file on %s: skipped", name, chain,
                        main.chain_id)  # fmt: skip
            continue
        addr = str(p["pool"]).lower()
        if addr in known:
            continue
        ps = p.get("priceSource")
        label = name if name.endswith("-v2") else f"{name}-v2"
        extra.append(PoolInfo(label, addr, ps.lower() if ps else None, _deploy_tx(p.get("txs")), "v2"))
    return Deployment(main.chain_id, main.rpc, main.pools + tuple(extra), main.perps, main.keeper)


def load(path: str | Path) -> Deployment | None:
    """The deployments file, plus its ``-v2`` sibling when present (see the module docstring)."""
    p = Path(path)
    sib = v2_sibling(p)
    v2_blob = None
    if not p.stem.endswith("-v2") and sib.exists():
        v2_blob = json.loads(sib.read_text(encoding="utf-8"))
    if not p.exists():
        return parse(v2_blob) if v2_blob is not None else None
    main = parse(json.loads(p.read_text(encoding="utf-8")))
    return merge_v2(main, v2_blob) if v2_blob is not None else main
