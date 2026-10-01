"""Read deployments/<env>.json (written by the contracts deploy scripts; read-only for the engine).

Shape used (see deployments/testnet.json): {"chainId", "rpc", "pools": {name: {"pool", "priceSource",
"txs": {"pool": <deploy tx hash>, ...}}}, "perps": {coin: index}}. Unknown keys are ignored.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def default_path(env: str) -> Path:
    return REPO_ROOT / "deployments" / f"{env}.json"


@dataclass(frozen=True)
class PoolInfo:
    name: str
    pool: str  # lower-case hex
    price_source: str | None
    deploy_tx: str | None


@dataclass(frozen=True)
class Deployment:
    chain_id: int | None
    rpc: str | None
    pools: tuple[PoolInfo, ...]
    perps: dict[str, int]

    def find(self, address: str) -> PoolInfo | None:
        a = address.lower()
        return next((p for p in self.pools if p.pool == a), None)

    def coin_of(self, perp_index: int) -> str | None:
        return next((c for c, i in self.perps.items() if i == perp_index), None)


def parse(blob: dict[str, Any]) -> Deployment:
    pools = []
    for name, p in (blob.get("pools") or {}).items():
        if not isinstance(p, dict) or "pool" not in p:
            continue
        txs = p.get("txs") or {}
        ps = p.get("priceSource")
        pools.append(PoolInfo(name, str(p["pool"]).lower(), ps.lower() if ps else None, txs.get("pool")))
    return Deployment(
        chain_id=int(blob["chainId"]) if "chainId" in blob else None,
        rpc=blob.get("rpc"),
        pools=tuple(pools),
        perps={str(k): int(v) for k, v in (blob.get("perps") or {}).items()},
    )


def load(path: str | Path) -> Deployment | None:
    p = Path(path)
    if not p.exists():
        return None
    return parse(json.loads(p.read_text(encoding="utf-8")))
