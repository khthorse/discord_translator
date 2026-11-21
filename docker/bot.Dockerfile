FROM node:22-bookworm-slim

ENV NODE_ENV=production DATA_DIR=/data
WORKDIR /app

COPY voice-bot/package.json voice-bot/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node voice-bot/ ./
RUN mkdir -p /data && chown -R node:node /data /app

USER node
CMD ["node", "index.js"]
