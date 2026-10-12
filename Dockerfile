# Tests run inside the build, so an image (and a deploy) only exists for a green commit.
FROM node:22-alpine AS test
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
RUN node --test tests/*.test.js

FROM node:22-alpine
ARG GIT_SHA=dev
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data GIT_SHA=${GIT_SHA}
WORKDIR /app
COPY --from=test /app/server.js /app/index.html /app/admin.html ./
COPY --from=test /app/server ./server
COPY --from=test /app/package.json ./
COPY --from=test /app/node_modules ./node_modules
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "server.js"]
