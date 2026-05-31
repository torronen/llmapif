# Stage 1: Build
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

# Runtime configuration is loaded from /app/config/llmapif.json (or
# /etc/llmapif/config.json) before the server starts. Do not bake database
# URLs, provider keys, admin passwords or encryption keys into the image.

EXPOSE 3001

# Run as non-root user
USER node

# Start the server
CMD ["npm", "start", "-w", "server"]
