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
