FROM node:24.19

RUN corepack enable

WORKDIR /app
COPY . .

RUN yarn install && \
    yarn build
