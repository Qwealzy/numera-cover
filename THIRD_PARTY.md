# Third-party code and licenses

Numera's own code is licensed under **AGPL-3.0-only** (see [`LICENSE`](LICENSE), decision D14).
This file lists every direct dependency, the license read from the installed copy (2026-10-02), and
whether it can be combined with AGPL-3.0. Transitive dependencies are not listed; lockfiles
(`app/package-lock.json`) and the installed metadata are the source of truth for those.

Compatibility rule used: permissive licenses (MIT, BSD, ISC, Apache-2.0, 0BSD, Zlib, CC0, PSF) and
weak-copyleft MPL-2.0 / LGPL can be used by an AGPL-3.0 project; Apache-2.0 is compatible with
(A)GPL-3.0 (not with GPL-2.0). Anything outside that set is flagged.

## Contracts (`contracts/lib`, git submodules, unmodified)

| dependency | version | license (source) | used for | AGPL-3.0 |
|---|---|---|---|---|
| OpenZeppelin Contracts | v5.4.0 | MIT (`lib/openzeppelin-contracts/LICENSE`) | ERC20, ERC4626, Ownable, Pausable, ReentrancyGuard, SafeERC20, ECDSA, EIP712, Math (compiled into `CoverPool` / `MockUSDC`) | compatible |
| forge-std | v1.17.0 | MIT OR Apache-2.0 (`lib/forge-std/LICENSE-MIT`, `LICENSE-APACHE`) | tests and deploy script only (not in deployed bytecode) | compatible |

Files under `contracts/lib/**` keep their own SPDX headers and licenses.

## Engine (`engine/pyproject.toml`, Python)

| dependency | installed version | license (package metadata) | AGPL-3.0 |
|---|---|---|---|
| numpy | 2.5.3 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | compatible (note 1) |
| scipy | 1.18.1 | BSD-3-Clause (classifier "BSD License") | compatible (note 2) |
| requests | 2.34.2 | Apache-2.0 | compatible |
| eth-account | 0.14.0 | MIT | compatible |
| web3 | 8.0.0 | MIT | compatible |
| fastapi | 0.142.2 | MIT | compatible |
| uvicorn | 0.54.0 | BSD-3-Clause | compatible |
| pytest (dev) | 9.1.1 | MIT | compatible (development only) |
| httpx (dev) | 0.28.1 | BSD-3-Clause | compatible (development only) |
| ruff (dev) | 0.16.9 | MIT | compatible (development only, not linked) |

1. numpy's expression includes 0BSD, Zlib and CC0-1.0 (bundled components). These are outside the
   MIT/BSD/ISC/Apache-2.0/MPL-2.0/PSF/LGPL list but are permissive and GPL-compatible; flagged for
   visibility only.
2. scipy and numpy binary wheels bundle native libraries (e.g. OpenBLAS, BSD-3-Clause; the GCC Fortran
   runtime, GPL-3.0 with the GCC Runtime Library Exception, per the wheels' `LICENSE.txt`; on Windows
   also the Microsoft C++ runtime `msvcp140.dll`, redistributable). Their license files ship inside the
   wheels; nothing is vendored into this repository, and none of this restricts AGPL-3.0 use.

## App (`app/package.json`, npm)

| dependency | installed version | license (`node_modules/<pkg>/package.json`) | AGPL-3.0 |
|---|---|---|---|
| marked | 18.0.14 | MIT | compatible |
| react | 19.3.0 | MIT | compatible |
| react-dom | 19.3.0 | MIT | compatible |
| viem | 2.57.2 | MIT | compatible |
| @types/node (dev) | 26.6.3 | MIT | compatible (types only) |
| @types/react (dev) | 19.3.0 | MIT | compatible (types only) |
| @types/react-dom (dev) | 19.3.0 | MIT | compatible (types only) |
| @vitejs/plugin-react (dev) | 6.1.1 | MIT | compatible (build only) |
| typescript (dev) | 7.0.2 | Apache-2.0 | compatible (build only) |
| vite (dev) | 8.3.2 | MIT | compatible (build only) |
| vitest (dev) | 5.0.3 | MIT | compatible (tests only) |

## Data and services (not code)

- Hyperliquid mainnet Info API (`candleSnapshot`), read-only, for calibration; HyperEVM testnet RPC and
  precompiles for the live demo. Used under Hyperliquid's public API terms; no Hyperliquid code is copied.

No dependency was found under a license that is incompatible with AGPL-3.0.
