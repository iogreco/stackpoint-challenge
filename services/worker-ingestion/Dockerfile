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
COPY services/worker-ingestion/package*.json ./services/worker-ingestion/
COPY services/worker-ingestion/tsconfig.json ./services/worker-ingestion/
COPY services/worker-ingestion/src/ ./services/worker-ingestion/src/

# Install dependencies
RUN npm install --workspace=@stackpoint/shared --workspace=@stackpoint/worker-ingestion

# Build shared package first
RUN npm run build --workspace=@stackpoint/shared

# Build service
RUN npm run build --workspace=@stackpoint/worker-ingestion

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY services/worker-ingestion/package*.json ./services/worker-ingestion/

# Copy built files
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/services/worker-ingestion/dist ./services/worker-ingestion/dist

# Copy docs for schema validation
COPY docs/contracts ./docs/contracts

# Install production dependencies
WORKDIR /app/services/worker-ingestion
RUN npm install --omit=dev --ignore-scripts

WORKDIR /app

# Start the worker
CMD ["node", "services/worker-ingestion/dist/index.js"]
