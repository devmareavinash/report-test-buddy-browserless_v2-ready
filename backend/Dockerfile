# Deno-based backend container hosting all edge functions in one process.
FROM denoland/deno:alpine-1.46.3

WORKDIR /app

# Corporate proxy (optional build-args for VDI builds)
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG http_proxy
ARG https_proxy
ARG NO_PROXY=127.0.0.1,localhost
ARG no_proxy=127.0.0.1,localhost
ENV HTTP_PROXY=$HTTP_PROXY \
    HTTPS_PROXY=$HTTPS_PROXY \
    http_proxy=$http_proxy \
    https_proxy=$https_proxy \
    NO_PROXY=$NO_PROXY \
    no_proxy=$no_proxy

# Copy edge functions and the gateway server
COPY supabase/functions ./functions
COPY backend/server.ts  ./server.ts
COPY backend/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Pre-cache all function deps at build time.
# --unsafely-ignore-certificate-errors: Bayer SSL inspection breaks Deno's Mozilla CA store.
# Runtime has no outbound DNS for esm.sh on many corp/Docker Desktop setups, so cache MUST succeed.
RUN set -e; \
    for fn in admin-users agent-analyze agent-heal agent-heal-script agent-orchestrate agent-scenarios agent-scrape agent-scripts bootstrap-admin playwright-runtime run-warehouse-sql schedule-tick test-warehouse-connectivity trigger-run; do \
      echo "Caching $fn..."; \
      deno cache --unsafely-ignore-certificate-errors --no-check "functions/${fn}/index.ts"; \
    done; \
    deno cache --unsafely-ignore-certificate-errors --no-check server.ts

EXPOSE 8000
ENV PORT=8000
# Clear bake-time proxy; compose/ECS inject runtime networking env.
ENV HTTP_PROXY= HTTPS_PROXY= http_proxy= https_proxy=

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8000/healthz || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]

