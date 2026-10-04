"""deploy/vps/numera.env.template must configure the engine for the Cloudflare Tunnel topology (audit M1) and
the keeper for the v2 pools, using only variables the code reads, with pool addresses taken from the repo."""

import re
from pathlib import Path

import pytest

from numera_engine.deployments import default_path
from numera_engine.deployments import load as load_deployment
from numera_engine.keeper import plan_pools
from numera_engine.quote_api import (
    RateLimitProxyError,
    Settings,
    build_pool_allowlist,
    check_rate_limit_proxy,
    client_ip,
    resolve_default_pool,
)

KIT = Path(__file__).resolve().parents[2] / "deploy" / "vps"
TEMPLATE = KIT / "numera.env.template"
SECRETS = ("QUOTE_SIGNER_KEY", "KEEPER_KEY")


def parse_template() -> dict[str, str]:
    """Same rules as systemd's EnvironmentFile: KEY=value lines, # lines are comments, no inline comments."""
    out: dict[str, str] = {}
    for line in TEMPLATE.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        assert re.fullmatch(r"[A-Z0-9_]+=[^\s#]*", line), f"not a plain KEY=value line: {line!r}"
        k, _, v = line.partition("=")
        out[k] = v
    return out


@pytest.fixture
def env(monkeypatch):
    values = parse_template()
    for k in list(values):
        monkeypatch.delenv(k, raising=False)
    for k, v in values.items():
        monkeypatch.setenv(k, v)
    return values


def test_template_has_no_secrets_and_no_pool_addresses():
    v = parse_template()
    assert all(v[k] == "" for k in SECRETS)
    assert v["NUMERA_POOLS"] == ""
    assert not re.search(r"0x[0-9a-fA-F]{40}", TEMPLATE.read_text(encoding="utf-8"))


def test_template_is_testnet_only(env):
    assert env["NUMERA_ENV"] == "testnet" and env["NUMERA_CHAIN_ID"] == "998"
    assert "999" not in env["NUMERA_CHAIN_ID"]


def test_engine_settings_from_template_pass_the_proxy_guard_and_trust_only_cloudflared(env):
    s = Settings.from_env()
    check_rate_limit_proxy(s)  # raises RateLimitProxyError when misconfigured
    assert s.proxy_mode == "proxy" and set(s.trusted_proxies) == {"127.0.0.1", "::1"}
    assert s.client_ip_header == "CF-Connecting-IP" and s.bind_host == "127.0.0.1"
    assert s.cors_origins[0] == "https://app.numeralabs.xyz"
    assert set(s.cors_origins) == {
        "https://app.numeralabs.xyz", "http://localhost:5173", "http://127.0.0.1:5173"
    }
    trusted = frozenset(s.trusted_proxies)
    assert client_ip("127.0.0.1", "203.0.113.5", trusted, "198.51.100.7") == "198.51.100.7"
    assert client_ip("198.51.100.99", None, trusted, "10.0.0.1") == "198.51.100.99"  # not via the tunnel


def test_dropping_the_trusted_proxy_makes_the_engine_refuse_to_start(env, monkeypatch):
    monkeypatch.setenv("NUMERA_TRUSTED_PROXIES", "")
    with pytest.raises(RateLimitProxyError):
        check_rate_limit_proxy(Settings.from_env())


def test_pools_and_keeper_come_from_the_deployments_files_not_the_template(env):
    dep = load_deployment(default_path(env["NUMERA_ENV"]))
    s = Settings.from_env()
    allow, default = build_pool_allowlist(s, dep, resolve_default_pool(s.pool, dep, v2_only=True))
    v2 = {p.pool for p in dep.pools if p.version == "v2"}
    assert v2 and set(allow) == v2  # chain 998 without NUMERA_POOLS: v2 pools only
    assert default in v2
    watched = {p.pool for p in plan_pools(dep, None, env["NUMERA_KEEPER_POOL_VERSION"])}
    assert watched == v2  # the keeper watches every v2 pool of the file


def test_every_numera_variable_in_the_template_is_read_by_the_code():
    pkg = Path(__file__).resolve().parents[1] / "numera_engine"
    src = "\n".join(p.read_text(encoding="utf-8") for p in pkg.glob("*.py"))
    for name in parse_template():
        if name.startswith("NUMERA_") or name in SECRETS:
            assert name in src, f"{name} is not read anywhere in numera_engine"
