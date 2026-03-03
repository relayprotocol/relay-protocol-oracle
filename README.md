## Relay Oracle

> #### Reference implementation of a Relay protocol oracle

See [overview](./docs/overview.md) for in-depth documentation on how the oracle works

### Installation

#### Testing

Run the tests via:

```sh
yarn test
```

#### Running the service

Before starting the service, make sure to have the required environment variables configured (check the [`.env.example`](./.env.example) file for all required and optional configuration variables).

Start the service via:

```sh
yarn start
```

(you can start things locally with `export $(cat .env | xargs) && yarn start` if you have first created `.env`. You also likely need to be connected using the VPN to access the RPC endpoints.)

### Railway deployment

For Railway, use the env-driven mainnet config:

- `ENVIRONMENT=mainnets.prod`
- `SIGNING_MODULE=raw-private-key`
- `ECDSA_PRIVATE_KEY=0x...`
- `API_KEYS=...` (optional)
- `PEERS=...` (optional)
- `PEER_REQUEST_TIMEOUT_MS=5000` (optional)

Chain RPCs are read from env vars using this pattern:

```sh
<CHAIN_ID_UPPERCASE>_RPC_URL=
```

Examples:

```sh
ETHEREUM_RPC_URL=
ARBITRUM_RPC_URL=
ARBITRUM_NOVA_RPC_URL=
POLYGON_ZKEVM_RPC_URL=
ARENA_Z_RPC_URL=
SOLANA_RPC_URL=
```

Additional non-RPC service envs:

```sh
HYPERLIQUID_HUB_API_URL=
BITCOIN_ESPLORA_API_URL=
```

The server port resolves in this order: `HTTP_PORT` -> `PORT` -> `3000`.
