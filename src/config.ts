export const config = {
  httpPort: Number(process.env.HTTP_PORT!),

  postgresUrl: process.env.POSTGRES_URL!,
  rabbitUrl: process.env.RABBIT_URL!,
  redisUrl: process.env.REDIS_URL!,
};
