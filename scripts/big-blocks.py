#!/usr/bin/env python
"""Switch the deployer between HyperEVM small and big blocks (TESTNET only; ARCHITECTURE §5.9 steps 2 and 4).

    python scripts/big-blocks.py on          # evmUserModify usingBigBlocks=true  (before the v2 deploy)
    python scripts/big-blocks.py off         # usingBigBlocks=false (after it, so admin txs use 1 s blocks)
    python scripts/big-blocks.py status      # read-only: deployer address, Core userRole, big-block flag
    python scripts/big-blocks.py on --sign-only   # sign the action locally and verify it; sends nothing

Run it with the engine venv python (`engine/.venv/Scripts/python` on Windows). It uses the official
hyperliquid-python-sdk (`Exchange.use_big_blocks`), pinned to SDK_VERSION below. The SDK's metadata caps
eth-account < 0.14 and eth-utils < 6, which the engine's web3 8 does not allow, so it is installed WITHOUT its
dependency pins (signing verified with eth-account 0.14 / eth-utils 6 by recovering the signer):
    engine/.venv/Scripts/python -m pip install --no-deps hyperliquid-python-sdk==0.24.0
    engine/.venv/Scripts/python -m pip install -e "engine[deploy]"      # msgpack, websocket-client

DEPLOYER_KEY is read from <repo>/.env (or --env <file>; the process environment as a fallback) inside this
script; it is never printed and never passed on a command line. The API URL is the SDK's TESTNET constant;
there is no way to point this script at mainnet. The address must already be a HyperCore user (fund it on
Core).
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

SDK_VERSION = "0.24.0"
ROOT = Path(__file__).resolve().parent.parent
TESTNET_CHAIN_ID = 998


def read_dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
        if not m:
            continue
        v = m.group(2).strip()
        if v[:1] in ("'", '"') and v.count(v[0]) >= 2:
            v = v[1 : v.index(v[0], 1)]
        else:
            v = re.sub(r"\s+#.*$", "", v).strip()
        out[m.group(1)] = v
    return out


def post_json(url: str, payload: dict) -> object:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers={"content-type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=15) as r:  # noqa: S310 (fixed https testnet URLs)
        return json.loads(r.read().decode())


def testnet_rpc() -> str:
    d = json.loads((ROOT / "deployments" / "testnet.json").read_text(encoding="utf-8"))
    return d["rpc"]


def evm_status(address: str) -> str:
    """Big-block flag via the HyperEVM JSON-RPC `eth_usingBigBlocks` (read-only; NOT VERIFIED on the node)."""
    rpc = testnet_rpc()
    chain = post_json(rpc, {"jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": []})
    if int(chain.get("result", "0x0"), 16) != TESTNET_CHAIN_ID:
        return f"refused: RPC answers chain {chain.get('result')}, not {TESTNET_CHAIN_ID}"
    res = post_json(rpc, {"jsonrpc": "2.0", "id": 2, "method": "eth_usingBigBlocks", "params": [address]})
    if "error" in res:
        msg = res["error"].get("message")
        return f"no read-only endpoint answered ({msg}); check the block of the next deploy tx"
    return f"usingBigBlocks = {res.get('result')}"


def load_sdk():
    try:
        version = importlib.metadata.version("hyperliquid-python-sdk")
    except importlib.metadata.PackageNotFoundError:
        sys.exit(f"hyperliquid-python-sdk is not installed; see the header of {Path(__file__).name}")
    if version != SDK_VERSION:
        sys.exit(f"hyperliquid-python-sdk {version} installed; this script is pinned to {SDK_VERSION}")
    from hyperliquid.utils import constants

    return constants


def main() -> int:
    p = argparse.ArgumentParser(description="Toggle HyperEVM big blocks for the deployer (testnet only).")
    p.add_argument("mode", choices=["on", "off", "status"])
    p.add_argument("--env", type=Path, default=ROOT / ".env", help="DEPLOYER_KEY file (default <repo>/.env)")
    p.add_argument("--sign-only", action="store_true", help="sign on|off locally and verify; send nothing")
    a = p.parse_args()

    key = read_dotenv(a.env).get("DEPLOYER_KEY") or os.environ.get("DEPLOYER_KEY", "")
    if not key:
        sys.exit("DEPLOYER_KEY is not set (.env or environment)")

    import eth_account

    wallet = eth_account.Account.from_key(key)
    del key
    constants = load_sdk()
    url = constants.TESTNET_API_URL
    if url == constants.MAINNET_API_URL or "testnet" not in url:
        sys.exit("refusing: not the testnet API")
    print(f"deployer {wallet.address} on {url}")

    if a.mode == "status":
        role = post_json(f"{url}/info", {"type": "userRole", "user": wallet.address})
        print(f"HyperCore userRole: {role}")
        print(evm_status(wallet.address))
        return 0

    enable = a.mode == "on"
    if a.sign_only:
        from hyperliquid.utils.signing import (
            get_timestamp_ms,
            recover_agent_or_user_from_l1_action,
            sign_l1_action,
        )

        action = {"type": "evmUserModify", "usingBigBlocks": enable}
        ts = get_timestamp_ms()
        sig = sign_l1_action(wallet, action, None, ts, None, False)
        signer = recover_agent_or_user_from_l1_action(action, sig, None, ts, None, False)
        ok = signer.lower() == wallet.address.lower()
        print(f"signed {action} (testnet domain); recovers to the deployer: {ok}; nothing sent")
        return 0 if ok else 1

    from hyperliquid.exchange import Exchange

    res = Exchange(wallet, url).use_big_blocks(enable)
    print(f"evmUserModify usingBigBlocks={enable}: {res}")
    return 0 if isinstance(res, dict) and res.get("status") == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
