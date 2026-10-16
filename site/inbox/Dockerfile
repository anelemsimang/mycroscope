FROM node:22-alpine
WORKDIR /app
COPY server.mjs .
RUN apk add --no-cache su-exec \
  && mkdir -p /data \
  && chown node:node /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["sh", "-c", "chown node:node /data && exec su-exec node node /app/server.mjs"]
