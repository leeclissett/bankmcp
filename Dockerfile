# Base image pinned by tag and by the digest of its multi-arch index. To move to a new Node 24 release, replace
# this one line: the tag says which release it is, the digest is what is actually pulled. Get the digest with
#   docker buildx imagetools inspect node:24.X.Y-alpine3.24   (first "Digest:" line)
FROM node:24.22.2-alpine3.24@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
LABEL org.opencontainers.image.title="BankMCP™" \
      org.opencontainers.image.description="Read-only MCP server for your own bank accounts via Enable Banking. Self-hosted, one user." \
      org.opencontainers.image.source="https://github.com/noskillish/bankmcp" \
      org.opencontainers.image.url="https://bankmcp.dk/" \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="io.github.noskillish/bankmcp"
# Pinned to the version in the base image's Alpine branch; the build fails loudly if Alpine replaces it.
RUN apk add --no-cache su-exec=0.3-r0 && rm -f /var/log/apk.log
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
COPY package.json package-lock.json ./
# Exactly what the lockfile says (npm ci refuses a lockfile out of step with package.json), no dev dependencies,
# no install scripts (none of the runtime dependencies has one). The npm cache and logs, apk's log and the V8
# compile cache npm leaves in /tmp differ from build to build, so they are removed to keep the layers identical.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && rm -rf /root/.npm /tmp/node-compile-cache
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.ts"]
