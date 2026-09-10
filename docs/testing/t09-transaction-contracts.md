# T09 transaction contracts

**Status, 2026-09-10.** This is a source-verification record made on 2026-09-08 and it still holds. The code it describes is on the branch `feat/ai-remediation`, at commit `6dc33d1`, which is pull request #40 into `main-v2`. Durable receipt updates and recovery, named at the end as separate parts of T09, are both in, and the manager now checks for a receipt on its own within a bounded budget. What has not happened is unchanged: no funded node, live chain endpoint or host has been queried from this branch.

The two commits below are the stack's, not this repository's, so `git cat-file` finds them only from inside `manager/swarm-hls-stream`.

The recorded review stack commit `ec3063f` pins Bee 2.8.2 in `nodes/docker-compose.yml`. The older manager baseline submodule `ee99c368` pins 2.8.1. These are local source facts. They do not prove the digest currently running on the host.

Read-only source verification on 2026-09-08 found:

- Bee 2.8.2 [chequebook.go](https://raw.githubusercontent.com/ethersphere/bee/v2.8.2/pkg/settlement/swap/chequebook/chequebook.go) deposits through its ERC20 service and calls `withdraw(amount)` against the chequebook for a withdrawal.
- Its [ERC20 service](https://raw.githubusercontent.com/ethersphere/bee/v2.8.2/pkg/settlement/swap/erc20/erc20.go) calls `transfer(chequebook, amount)` against the token. Both requests send zero native value.
- Bee pins go-sw3-abi v0.6.9. The [pinned ABI](https://raw.githubusercontent.com/ethersphere/go-sw3-abi/v0.6.9/sw3abi/abi_v0.6.9.go) declares `transfer(address,uint256)` and `withdraw(uint256)`. SHA256 of that downloaded file is `c24c992c160f0b22cba002bda8d285b74682be520e3d50fe27356f77472e079b`.
- Keccak-256 of those signatures gives selectors `a9059cbb` and `2e1a7d4d`. They were independently computed with the already installed @noble/hashes 1.8.0. No dependency was added.
- [Swarm's token reference](https://docs.ethswarm.org/docs/references/smart-contracts/) supplies the Ethereum, Gnosis and Sepolia token addresses used by the matcher. An unknown chain or a different frozen token address refuses matching.
- Bee's [transaction API implementation](https://raw.githubusercontent.com/ethersphere/bee/v2.8.2/pkg/api/transaction.go) exposes pending hashes and hex calldata. Recovery uses those hashes to obtain full chain evidence. It never infers sender or chain solely from Bee's pending list.

The parser follows the [Ethereum JSON-RPC reference](https://ethereum.org/developers/docs/apis/json-rpc/). Amounts and nonces remain exact integers. Legacy transactions must carry an EIP-155 protected chain id, derived from `v` and checked against an explicit chain id when present. Typed transactions require an explicit chain id. Malformed or contradictory fields fail with a fixed error.

The matcher requires sender, chain, token or chequebook destination, zero native value, exact ABI arguments and the saved nonce and block bounds. A matching pending transaction remains pending. The parser distinguishes receipt success, revert and absence.

Receipt confirmation requires a matching transaction and receipt, a canonical frozen start block, and a canonical receipt block at or below the RPC's `finalized` block. The finalized tag is checked against that block's numbered header. A parent-linked walk from that finalized block must include the exact receipt and frozen start hashes. This rejects mixed histories returned by different RPC backends. Receipt status 1 means settled and status 0 means reverted only when these checks pass. A mined receipt before finality remains pending. Missing or unsupported finalized evidence remains could not check, with no fallback to latest or a balance change. The complete inspection has a 15-second deadline, including reader preparation, and cancels in-flight reads when it ends. The walk also has a 512-parent limit. An incomplete history never confirms.

Long histories resume from a persisted checkpoint within the receipt observation. It binds the transaction, receipt status and block, originally observed finalized block and last verified parent-linked block. A later check verifies those identities again and continues toward the frozen start block. It does not chase an advancing finalized tip. Timeouts, RPC failures and temporarily absent observations retain only verified progress. Contradictory receipt or chain evidence discards that checkpoint and remains unresolved. A receipt hash is checked before a chunk can record its boundary at that block. The checkpoint comes only from the internal journal, never from operator input.

Each receipt write compares the operation's id, transaction hash, submitted state and revision captured before inspection. Every successful journal update advances the revision, including a failed observation. A late success cannot overwrite a newer failure. Receipt observations and checkpoints are whitelisted before storage. Terminal results release the node guard only after the journal write succeeds.

The [JSON-RPC reference](https://ethereum.org/developers/docs/apis/json-rpc/) defines the finalized block tag. [Nethermind's RPC reference](https://docs.nethermind.io/interacting/json-rpc-ns/eth/) also lists it for `eth_getBlockByNumber`. This is the client confirmation contract. The configured live RPC's support was not tested. Durable receipt updates and recovery were separate parts of T09 when this was written. Both are in.

No funded node, live chain endpoint or host was queried. The 0.5 BZZ chequebook fill's submission remains unverified.
