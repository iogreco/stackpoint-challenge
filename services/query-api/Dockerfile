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
COPY services/query-api/package*.json ./services/query-api/
COPY services/query-api/tsconfig.json ./services/query-api/
COPY services/query-api/src/ ./services/query-api/src/

# Install dependencies
RUN npm install --workspace=@stackpoint/shared --workspace=@stackpoint/query-api

# Build shared package first
RUN npm run build --workspace=@stackpoint/shared

# Build service
RUN npm run build --workspace=@stackpoint/query-api

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY services/query-api/package*.json ./services/query-api/

# Copy built files
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/services/query-api/dist ./services/query-api/dist

# Copy docs for schema validation
COPY docs/contracts ./docs/contracts

# Install production dependencies
WORKDIR /app/services/query-api
RUN npm install --omit=dev --ignore-scripts

WORKDIR /app

# Expose port
EXPOSE 8081

# Start the service
CMD ["node", "services/query-api/dist/index.js"]
