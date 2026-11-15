FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json vite.config.ts ./
RUN npm ci
COPY src src
COPY public public
COPY sw sw
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/free-now.sqlite
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# dist holds the server (dist/*.js) and the bundled client (dist/client), which the server serves.
COPY --from=build /app/dist dist
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server.js"]
