# Bevara filter registry — single Node process, SQLite + files under /data.
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
RUN mkdir -p /data && chown -R node:node /data /app
USER node
ENV PORT=8080 DATA_DIR=/data HOST=0.0.0.0
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/-/ping || exit 1
CMD ["node", "src/server.js"]
