# ---------- Build stage ----------
  FROM node:22-alpine AS build
  WORKDIR /app
  
  # Corporate proxies (optional build-args)
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
  
  # Install deps — prefer npm when package-lock.json exists (team uses npm on this repo)
  COPY package.json package-lock.json* ./
  RUN if [ -f package-lock.json ]; then \
        npm ci --no-audit --no-fund; \
      else \
        npm install --no-audit --no-fund; \
      fi
  
  # Build-time env (Vite inlines VITE_* vars at build time)
  ARG VITE_SUPABASE_URL
  ARG VITE_SUPABASE_PUBLISHABLE_KEY
  ARG VITE_SUPABASE_PROJECT_ID
  ARG VITE_USE_LOCAL_BACKEND=true
  ARG VITE_RUN_SESSION_REFRESH=true
  ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
      VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
      VITE_SUPABASE_PROJECT_ID=$VITE_SUPABASE_PROJECT_ID \
      VITE_USE_LOCAL_BACKEND=$VITE_USE_LOCAL_BACKEND \
      VITE_RUN_SESSION_REFRESH=$VITE_RUN_SESSION_REFRESH
  
  COPY . .
  RUN npm run build
  
  # ---------- Runtime stage ----------
FROM nginx:1.27-alpine

ENV BACKEND_UPSTREAM=backend:8000

COPY nginx.runtime.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
  HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost/ || exit 1
  CMD ["nginx", "-g", "daemon off;"]
  