## Relay Oracle

> #### Reference implementation of a Relay protocol oracle

For protocol and indexing details:

- See [overview](./docs/overview.md) for what the oracle attests and the API surface.
- See [ethereum-vm indexing](./docs/indexing/ethereum-vm.md) and [solana-vm indexing](./docs/indexing/solana-vm.md) for chain-specific behavior.

### Installation

#### Testing

Run the tests via:

```sh
yarn test
```

#### Local development

Before starting the service, make sure to have the required environment variables configured (check the [`.env.example`](./.env.example) file for a minimal example).

Start the service via:

```sh
yarn start
```

(you can start things locally with `export $(cat .env | xargs) && yarn start` if you have first created `.env`. You also likely need to be connected using the VPN to access the RPC endpoints.)

### Run a Third-Party Oracle

This section is the canonical quick-start for external operators.

#### Deployment model

Run the oracle as a Dockerized HTTP service.

The recommended deployment artifact is the published image:

```sh
ghcr.io/relayprotocol/relay-protocol-oracle
```

Different operators can use different hosting services, as long as they can run that Docker image and expose the service over HTTPS.

#### Required configuration

At minimum, a raw-key deployment needs:

```sh
ENVIRONMENT=mainnets.prod
ECDSA_PRIVATE_KEY=0x...
RELAY_RPC_URL=https://rpc.chain.relay.link/rpc
```

Notes:

- `ENVIRONMENT` selects the chain config files the service loads.
- `RELAY_RPC_URL` is the RPC endpoint for the Relay hub chain. It is required for
  the `mainnets.prod` / `mainnets.stag` configs.
- `ECDSA_PRIVATE_KEY` is required for the default signing path.
- `SIGNING_MODULE=raw-private-key` is optional because raw-key signing is the default path, but setting it explicitly is fine.
- The service currently supports `raw-private-key` and `aws-kms`.

Optional:

```sh
API_KEYS=your-api-key:your-name
UNAUTHENTICATED_RATE_LIMIT_MAX=2
UNAUTHENTICATED_RATE_LIMIT_WINDOW_MS=1000
```

Requests without a valid `x-api-key` are publicly reachable but rate limited globally per client IP. Requests with a valid `x-api-key` bypass the unauthenticated rate limit.

If you use AWS KMS instead of a raw private key:

```sh
SIGNING_MODULE=aws-kms
AWS_KMS_SIGNER_KEY_ID=...
AWS_KMS_SIGNER_KEY_REGION=...
```

Additional optional runtime settings:

```sh
ETHEREUM_RPC_URL=
BASE_RPC_URL=
ARBITRUM_RPC_URL=
BNB_RPC_URL=
POLYGON_RPC_URL=
SOLANA_RPC_URL=
BITCOIN_RPC_URL=
HYPERLIQUID_RPC_URL=
PORT=3000
PEERS=https://peer-one.example.com|peer-api-key;https://peer-two.example.com|peer-api-key
PEER_REQUEST_TIMEOUT_MS=5000
```

Notes:

- The service listens on `PORT`, then `HTTP_PORT`, then `3000`.
- On Railway, add `PORT` in the service settings.
- If `PORT` is present, it takes precedence over `HTTP_PORT`.
- You can set only the RPC vars you want to override; if unset, the oracle uses built-in defaults where available.
- `PEERS` enables best-effort peer signature fanout for execution-producing requests.
- `PEER_REQUEST_TIMEOUT_MS` defaults to `5000`.

#### RPC and chain service variables

The oracle includes built-in RPC defaults for many networks.
You do not need to provide RPC URLs for every network.
Set RPC env vars only for networks where you want your own provider.

Recommended custom RPC overrides for production operators:

- `SOLANA_RPC_URL`
- `ETHEREUM_RPC_URL`
- `POLYGON_RPC_URL`
- `BASE_RPC_URL` (recommended)
- `ARBITRUM_RPC_URL` (recommended)

There are two classes of variables to supply:

- Chain RPC URLs (optional overrides).
- Chain-specific service URLs or API keys where a plain RPC endpoint is not enough.

Common supplemental variables include:

```sh
HYPERLIQUID_HUB_API_URL=
HYPERLIQUID_HUB_API_KEY=
HYPERLIQUID_PROXY_API_URL=
HYPERLIQUID_PROXY_API_KEY=
BITCOIN_ESPLORA_COMPATIBLE_API_URL=
BITCOIN_BLOCKSTREAM_CLIENT_ID=
BITCOIN_BLOCKSTREAM_CLIENT_SECRET=
BITCOIN_MAESTRO_API_KEY=
LIGHTER_RPC_API_KEY=
```

Why these matter:

- The oracle depends on these values to read chain state.
- Missing or invalid values will break the attestation paths that depend on them.
- Some chains require provider-specific companion services in addition to a standard RPC endpoint, even when RPC defaults exist.

Use provider secrets the same way you would for any other production credential.

#### Authentication

Requests without a valid `x-api-key` are allowed on protected routes, but they use the unauthenticated rate limit.

These routes remain accessible without an API key:

- `/documentation`
- `/lives/v1`

`/chains/v1` and the attestation routes are publicly reachable. Requests with a valid `x-api-key` bypass unauthenticated rate limiting. Requests without a valid `x-api-key` are rate limited globally per client IP.

`API_KEYS` format:

```sh
API_KEYS=key-one:partner-a;key-two:partner-b
```

Unauthenticated rate limit configuration:

```sh
UNAUTHENTICATED_RATE_LIMIT_MAX=2
UNAUTHENTICATED_RATE_LIMIT_WINDOW_MS=1000
```

The `force` option on solver fill and refund attestations still requires a valid `x-api-key`.

#### Peering

Use `PEERS` to configure other oracle instances that this instance should call when peer signatures are requested.

Format:

```sh
PEERS=https://peer-a.example.com|peer-a-key;https://peer-b.example.com|peer-b-key
```

Each `PEERS` entry is:

- the peer base URL
- the API key to send to that peer

Example with the Relay-hosted oracle:

```sh
PEERS=https://oracle.relay.link|peer-api-key
```

Peer calls are best-effort. If a peer times out, errors, or does not agree with the local result, it is skipped.

`pass-through` is also supported in place of a peer key, but dedicated peer keys are the safer default for external operators.

#### Docker run

Pull and run the published image directly:

```sh
docker pull ghcr.io/relayprotocol/relay-protocol-oracle
docker run --rm -p 3000:3000 --env-file .env ghcr.io/relayprotocol/relay-protocol-oracle
```

#### Railway deployment

On Railway, configure the service to deploy from:

```sh
ghcr.io/relayprotocol/relay-protocol-oracle
```

Then add the required environment variables in the Railway service settings, including:

```sh
PORT=3000
```

For this GHCR image, Railway requires GHCR registry credentials. Use the standard GHCR flow:

- Create a GitHub Personal Access Token with `read:packages`.
- Add it in Railway's GitHub Access Token field for the service.

#### First-run checks

After deployment, verify:

- `GET /lives/v1` returns `{"status":"ok"}`.
- `GET /documentation` loads.
- `GET /chains/v1` returns the expected chain list without an API key.
- Startup logs show the signer address you expect.

Then test one real attestation request.

#### Example test attestation request

The simplest post-deploy attestation test is a depository-deposit attestation. Use a real transaction hash from a supported chain that contains a Relay depository deposit.

```sh
curl -X POST http://localhost:3000/attestations/depository-deposits/v1 \
  -H 'content-type: application/json' \
  -d '{
    "chainId": "ethereum",
    "transactionId": "0xREPLACE_WITH_A_REAL_DEPOSIT_TRANSACTION_HASH",
    "requestPeerSignatures": false
  }'
```

Notes:

- Replace `http://localhost:3000` with your deployed base URL.
- Add `-H 'x-api-key: your-api-key'` when you want to bypass unauthenticated rate limiting.
- Replace `chainId` with a chain that is enabled in your selected `ENVIRONMENT`.
- Replace `transactionId` with a real transaction that contains a Relay depository deposit on that chain.

On success, the service returns a `200` response with a `messages` array containing one or more signed deposit attestations, and it may also include an `execution` object.

If the request returns `400`, the most common causes are:

- the chain is not enabled in your config
- the transaction is not a valid Relay deposit for that endpoint
- the relevant RPC or chain-service variables are missing or invalid
