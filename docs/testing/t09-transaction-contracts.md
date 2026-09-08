# T09 transaction contracts

The recorded review stack commit `ec3063f` pins Bee 2.8.2 in `nodes/docker-compose.yml`. The older manager baseline submodule `ee99c368` pins 2.8.1. These are local source facts. They do not prove the digest currently running on the host.

Read-only source verification on 2026-09-08 found:

- Bee 2.8.2 [chequebook.go](https://raw.githubusercontent.com/ethersphere/bee/v2.8.2/pkg/settlement/swap/chequebook/chequebook.go) deposits through its ERC20 service and calls `withdraw(amount)` against the chequebook for a withdrawal.
- Its [ERC20 service](https://raw.githubusercontent.com/ethersphere/bee/v2.8.2/pkg/settlement/swap/erc20/erc20.go) calls `transfer(chequebook, amount)` against the token. Both requests send zero native value.
- Bee pins go-sw3-abi v0.6.9. The [pinned ABI](https://raw.githubusercontent.com/ethersphere/go-sw3-abi/v0.6.9/sw3abi/abi_v0.6.9.go) declares `transfer(address,uint256)` and `withdraw(uint256)`. SHA256 of that downloaded file is `c24c992c160f0b22cba002bda8d285b74682be520e3d50fe27356f77472e079b`.
- Keccak-256 of those signatures gives selectors `a9059cbb` and `2e1a7d4d`. They were independently computed with the already installed @noble/hashes 1.8.0. No dependency was added.
- [Swarm's token reference](https://docs.ethswarm.org/docs/references/smart-contracts/) supplies the Ethereum, Gnosis and Sepolia token addresses used by the matcher. An unknown chain or a different frozen token address refuses matching.
- Bee's [transaction API implementation](https://raw.githubusercontent.com/ethersphere/bee/v2.8.2/pkg/api/transaction.go) exposes pending hashes and hex calldata. Recovery uses those hashes to obtain full chain evidence. It never infers sender or chain solely from Bee's pending list.

The parser follows the [Ethereum JSON-RPC reference](https://ethereum.org/developers/docs/apis/json-rpc/). Amounts and nonces remain exact integers. Legacy transactions must carry an EIP-155 protected chain id, derived from `v` and checked against an explicit chain id when present. Typed transactions require an explicit chain id. Malformed or contradictory fields fail with a fixed error.

The matcher requires sender, chain, token or chequebook destination, zero native value, exact ABI arguments and the saved nonce and block bounds. A matching pending transaction remains pending. The parser distinguishes receipt success, revert and absence. Canonical-block checks, durable receipt updates and recovery are separate parts of T09 and must finish before the flow is enabled.

No funded node, live chain endpoint or host was queried. The 0.5 BZZ chequebook fill's submission remains unverified.
