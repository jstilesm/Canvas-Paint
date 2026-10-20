FROM node:22-alpine
WORKDIR /code
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
EXPOSE 8000
CMD ["yarn", "web"]