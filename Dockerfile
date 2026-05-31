# Stage 1: Build
# Debian (glibc) base rather than Alpine (musl): the better-sqlite3 native
# addon ships prebuilt glibc binaries, so this avoids the musl "Exec format
# error" you get when an incompatible prebuilt binary is pulled on Alpine.
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Copy workspace package.json files
COPY package.json package-lock.json* ./
COPY client/package.json ./client/
COPY server/package.json ./server/
COPY shared/package.json ./shared/

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build both client and server
RUN npm run build

# Stage 2: Production
FROM node:22-bookworm-slim

WORKDIR /app

# Copy built artifacts and node_modules from builder. `shared` is a type-only
# workspace (shared/types.ts), so it's erased at compile time and not needed at
# runtime — but we copy its source so the workspace symlink in node_modules
# resolves cleanly. There is no shared/dist to copy.
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/server/package.json ./server/
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist

# Create a data directory for the SQLite database
RUN mkdir -p /data && chown -R node:node /data

# Set environment variables. The server binds to loopback by default; inside a
# container it must bind to 0.0.0.0 to be reachable via the published port.
# Because that exposes the admin API beyond loopback, ADMIN_ALLOW_REMOTE=true is
# also set — which makes ADMIN_PASSWORD mandatory: the server refuses to start
# without it (see assertRemoteAccessIsSafe). ENCRYPTION_KEY and ADMIN_PASSWORD
# must be provided at runtime (e.g. via docker-compose env / `docker run -e`).
ENV NODE_ENV=production
ENV PORT=3001
ENV DATABASE_PATH=/data/freeapi.db
ENV BIND_HOST=0.0.0.0
ENV ADMIN_ALLOW_REMOTE=true

# Expose the port
EXPOSE 3001

# Run as non-root user
USER node

# Start the server
CMD ["npm", "start", "-w", "server"]
