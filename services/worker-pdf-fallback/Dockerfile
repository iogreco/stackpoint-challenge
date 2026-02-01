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
COPY services/worker-pdf-fallback/package*.json ./services/worker-pdf-fallback/
COPY services/worker-pdf-fallback/tsconfig.json ./services/worker-pdf-fallback/
COPY services/worker-pdf-fallback/src/ ./services/worker-pdf-fallback/src/

# Install dependencies
RUN npm install --workspace=@stackpoint/shared --workspace=@stackpoint/worker-pdf-fallback

# Build shared package first
RUN npm run build --workspace=@stackpoint/shared

# Build service
RUN npm run build --workspace=@stackpoint/worker-pdf-fallback

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY services/worker-pdf-fallback/package*.json ./services/worker-pdf-fallback/

# Copy built files
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/services/worker-pdf-fallback/dist ./services/worker-pdf-fallback/dist

# Copy docs for schema validation
COPY docs/contracts ./docs/contracts

# Install production dependencies
WORKDIR /app/services/worker-pdf-fallback
RUN npm install --omit=dev

WORKDIR /app

# Start the worker
CMD ["node", "services/worker-pdf-fallback/dist/index.js"]
