export const config = {
  httpPort: Number(process.env.HTTP_PORT!),
  environment: process.env.ENVIRONMENT!,
  ecdsaPrivateKey: process.env.ECDSA_PRIVATE_KEY!,
};
