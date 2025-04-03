FROM node:23-slim

WORKDIR /service
ADD . /service

RUN yarn install
RUN yarn build

CMD yarn start