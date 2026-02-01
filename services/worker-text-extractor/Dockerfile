FROM node:20-alpine AS builder

# Install build dependencies for canvas (needed by pdfjs-dist)
RUN apk add --no-cache \
    build-base \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev \
    python3

WORKDIR /app

# Copy root package files for workspaces
COPY package*.json ./
COPY tsconfig.base.json ./

# Copy shared package
COPY packages/shared/package*.json ./packages/shared/
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src/ ./packages/shared/src/

# Copy service package
COPY services/worker-text-extractor/package*.json ./services/worker-text-extractor/
COPY services/worker-text-extractor/tsconfig.json ./services/worker-text-extractor/
COPY services/worker-text-extractor/src/ ./services/worker-text-extractor/src/

# Install dependencies
RUN npm install --workspace=@stackpoint/shared --workspace=@stackpoint/worker-text-extractor

# Build shared package first
RUN npm run build --workspace=@stackpoint/shared

# Build service
RUN npm run build --workspace=@stackpoint/worker-text-extractor

# Production stage
FROM node:20-alpine

# Install runtime dependencies for canvas
RUN apk add --no-cache cairo jpeg pango giflib

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY services/worker-text-extractor/package*.json ./services/worker-text-extractor/

# Copy built files
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/services/worker-text-extractor/dist ./services/worker-text-extractor/dist

# Copy node_modules from builder (hoisted at root level with workspaces)
COPY --from=builder /app/node_modules ./node_modules

# Copy docs for schema validation
COPY docs/contracts ./docs/contracts

WORKDIR /app

# Start the worker
CMD ["node", "services/worker-text-extractor/dist/index.js"]
