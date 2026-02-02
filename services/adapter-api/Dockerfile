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
COPY services/adapter-api/package*.json ./services/adapter-api/
COPY services/adapter-api/tsconfig.json ./services/adapter-api/
COPY services/adapter-api/src/ ./services/adapter-api/src/

# Install dependencies
RUN npm install --workspace=@stackpoint/shared --workspace=@stackpoint/adapter-api

# Build shared package first
RUN npm run build --workspace=@stackpoint/shared

# Build service
RUN npm run build --workspace=@stackpoint/adapter-api

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY services/adapter-api/package*.json ./services/adapter-api/

# Copy built files
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/services/adapter-api/dist ./services/adapter-api/dist

# Copy docs for schema validation
COPY docs/contracts ./docs/contracts

# Install production dependencies
WORKDIR /app/services/adapter-api
RUN npm install --omit=dev --ignore-scripts

WORKDIR /app

# Expose port
EXPOSE 8080

# Start the service
CMD ["node", "services/adapter-api/dist/index.js"]
