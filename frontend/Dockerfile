# WorkflowOS frontend Docker image (WORK-023).
#
# Multi-stage build:
#   1. Build the Vite production bundle (static HTML/JS/CSS).
#   2. Serve it with nginx — a lightweight static file server that also
#      proxies API requests to the backend container.
#
# The frontend is a consumer only — it never owns authoritative state.
# It reaches the Backend API through nginx's reverse proxy (/api → backend).

# --- Stage 1: build the SPA ---
FROM oven/bun:1.3.14 AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# --- Stage 2: serve with nginx ---
FROM nginx:1.27-alpine

# Remove the default nginx static site (we provide our own).
RUN rm -rf /usr/share/nginx/html/*

# Copy the built SPA into nginx's static root.
COPY --from=build /app/dist /usr/share/nginx/html

# Custom nginx config: serve the SPA + proxy /api to the backend.
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
