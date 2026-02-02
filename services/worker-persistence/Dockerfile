FROM node:20-alpine AS builder

WORKDIR /app

# Copy root package files for workspaces
COPY package*.json ./
COPY tsconfig.base.json ./

# Copy shared package
COPY packages/shared/package*.json ./packages/shared/
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src/ ./packages/shared/src/

# Copy service package
COPY services/worker-persistence/package*.json ./services/worker-persistence/
COPY services/worker-persistence/tsconfig.json ./services/worker-persistence/
COPY services/worker-persistence/src/ ./services/worker-persistence/src/

# Install dependencies
RUN npm install --workspace=@stackpoint/shared --workspace=@stackpoint/worker-persistence

# Build shared package first
RUN npm run build --workspace=@stackpoint/shared

# Build service
RUN npm run build --workspace=@stackpoint/worker-persistence

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY services/worker-persistence/package*.json ./services/worker-persistence/

# Copy built files
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/services/worker-persistence/dist ./services/worker-persistence/dist

# Copy schema (from source, not built)
COPY services/worker-persistence/src/schema ./services/worker-persistence/src/schema

# Copy docs for schema validation
COPY docs/contracts ./docs/contracts

# Install production dependencies
WORKDIR /app/services/worker-persistence
RUN npm install --omit=dev --ignore-scripts

WORKDIR /app

# Run schema init then start worker (one-time when starting from scratch)
CMD ["sh", "-c", "node services/worker-persistence/dist/init-db.js && node services/worker-persistence/dist/index.js"]
