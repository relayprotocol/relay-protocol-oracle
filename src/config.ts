export const config = {
  httpPort: Number(process.env.HTTP_PORT!),
  environment: process.env.ENVIRONMENT!,
  ecdsaPrivateKey: process.env.ECDSA_PRIVATE_KEY!,
  apiKeys: process.env.API_KEYS
    ? Object.fromEntries(
        process.env.API_KEYS.split(";").map((apiKey) => {
          const [key, integrator] = apiKey.split(":");
          return [key, integrator];
        })
      )
    : undefined,
  onChainOracleAddress: process.env.ON_CHAIN_ORACLE_CONTRACT_ADDRESS!,
  onChainOracleChainId: process.env.ON_CHAIN_ORACLE_CHAIN_ID!,
};
