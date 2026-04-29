FROM node:23-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends libjemalloc2 \
  && rm -rf /var/lib/apt/lists/*

ARG HTTP_PORT=80
EXPOSE ${HTTP_PORT}

WORKDIR /service
ADD . /service

RUN yarn install
RUN yarn build
COPY entrypoint.sh /entrypoint.sh

ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2

ENTRYPOINT ["/entrypoint.sh"]
CMD yarn start
