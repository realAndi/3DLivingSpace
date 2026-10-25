# One stage: nothing is built. The image carries the server, the browser files
# it serves, the fonts it draws link previews with, and three runtime
# dependencies.
FROM node:24-alpine
# Lets a host prune this app's old images without touching anyone else's.
LABEL org.opencontainers.image.source="https://github.com/realAndi/3DLivingSpace"
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    LISTEN=8790
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY src ./src
COPY assets ./assets
COPY index.html ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 CMD ["node", "server/healthcheck.js"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
