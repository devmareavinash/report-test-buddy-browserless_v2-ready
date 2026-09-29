#!/bin/sh
# Runtime entrypoint for the Deno backend gateway.
# When HTTP(S)_PROXY is set (corp VDI Docker), Deno must ignore MITM TLS certs
# to call Supabase Auth / PostgREST. AWS ECS typically has no proxy — clean TLS.
set -e

EXTRA_FLAGS=""
if [ -n "${HTTP_PROXY}${HTTPS_PROXY}${http_proxy}${https_proxy}" ]; then
  EXTRA_FLAGS="--unsafely-ignore-certificate-errors"
  if [ -z "${DENO_TLS_CA_STORE}" ]; then
    export DENO_TLS_CA_STORE=system
  fi
fi

exec deno run --cached-only $EXTRA_FLAGS --allow-net --allow-env --allow-read --allow-write server.ts
