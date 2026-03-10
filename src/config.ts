export const config = {
  httpPort: Number(process.env.HTTP_PORT ?? process.env.PORT ?? 3000),
  environment: process.env.ENVIRONMENT!,
  peerRequestTimeoutMs: Number(process.env.PEER_REQUEST_TIMEOUT_MS ?? 30000),

  apiKeys: process.env.API_KEYS
    ? Object.fromEntries(
        process.env.API_KEYS.split(";").map((apiKey) => {
          const [key, integrator] = apiKey.split(":");
          return [key, integrator];
        }),
      )
    : undefined,

  peers: process.env.PEERS
    ? Object.fromEntries(
        process.env.PEERS.split(";").map((peer) => {
          const [url, apiKey] = peer.split("|");
          return [url, apiKey];
        }),
      )
    : undefined,

  signingModule: process.env.SIGNING_MODULE,

  // For "raw-private-key" signing module
  ecdsaPrivateKey: process.env.ECDSA_PRIVATE_KEY,

  // For "aws-kms" signing module
  awsKmsSignerKeyId: process.env.AWS_KMS_SIGNER_KEY_ID,
  awsKmsSignerKeyRegion: process.env.AWS_KMS_SIGNER_KEY_REGION,
};
