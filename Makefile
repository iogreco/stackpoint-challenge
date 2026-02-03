.PHONY: build up down logs test test-e2e test-e2e-no-llm clean clean-all reset obs-setup obs-load obs-cleanup install

# Default target
all: build up

# Install dependencies
install:
	npm install

# Build all services
build:
	docker compose build

# Start all services
up:
	docker compose up -d

# Stop all services
down:
	docker compose down

# View logs
logs:
	docker compose logs -f

# View logs for specific service
logs-%:
	docker compose logs -f $*

# Run unit tests
test:
	npm test

# Run E2E tests (no OpenAI): pipeline health/sync only, isolated compose stack
test-e2e-no-llm:
	docker compose -f docker-compose.yml -f docker-compose.test.yml up -d
	npm run test:e2e -- --testPathPattern="pipeline.e2e"
	docker compose -f docker-compose.yml -f docker-compose.test.yml down

# Run full E2E tests (including OpenAI extraction-quality). Requires OPENAI_API_KEY (in .env or exported).
test-e2e:
	docker compose -f docker-compose.yml -f docker-compose.test.yml up -d
	@( [ -f .env ] && set -a && . ./.env && set +a; RUN_E2E_TESTS=1 npm run test:e2e )
	docker compose -f docker-compose.yml -f docker-compose.test.yml down

# Reset state for clean test (fresh Postgres/Redis/test DB, remove service dist; keeps node_modules and packages/shared dist)
reset:
	docker compose -f docker-compose.yml -f docker-compose.test.yml down -v --rmi local
	rm -rf services/*/dist

# Clean: tear down stack + volumes + local images, remove service dist only. Keeps node_modules and packages/*/dist.
clean: reset

# Clean-all: same as clean but also removes all node_modules and all dist. Use for a full reinstall (e.g. after Node/dep changes).
clean-all:
	docker compose -f docker-compose.yml -f docker-compose.test.yml down -v --rmi local
	rm -rf node_modules
	rm -rf packages/*/node_modules
	rm -rf packages/*/dist
	rm -rf services/*/node_modules
	rm -rf services/*/dist

# Observability setup - Start Prometheus + Grafana
obs-setup:
	docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d

# Run k6 load test
obs-load:
	docker compose -f docker-compose.yml -f docker-compose.observability.yml --profile load up k6-load

# Cleanup observability stack
obs-cleanup:
	docker compose -f docker-compose.yml -f docker-compose.observability.yml down -v

# Health check all services
health:
	@echo "Checking Adapter API..."
	@curl -sf http://localhost:8080/health || echo "Adapter API not healthy"
	@echo "\nChecking Query API..."
	@curl -sf http://localhost:8081/health || echo "Query API not healthy"
	@echo "\nChecking Fixture Source..."
	@curl -sf http://localhost:9000/health || echo "Fixture Source not healthy"

# Trigger a sync
sync:
	curl -X POST http://localhost:8080/sync \
		-H "Content-Type: application/json" \
		-d '{"source_system":"fixture_source","max_documents":10}'

# List borrowers
borrowers:
	curl -s http://localhost:8081/borrowers | jq

# Rebuild and restart a specific service
restart-%:
	docker compose build $*
	docker compose up -d $*

# View Redis queue info
queue-info:
	docker compose exec redis redis-cli info | grep -E "used_memory|connected_clients|aof_"

# View Postgres info
db-info:
	docker compose exec postgres psql -U stackpoint_user -d stackpoint -c "\dt"
