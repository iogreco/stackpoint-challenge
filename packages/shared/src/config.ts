/**
 * Centralized Configuration
 *
 * All configuration values can be tuned via environment variables.
 */

export interface Config {
  // Redis
  redisHost: string;
  redisPort: number;
  redisUrl: string;

  // Queue & Worker
  workerConcurrency: number;
  maxJobAttempts: number;
  backoffBaseMs: number;

  // Backpressure Controls
  maxQueueDepthWarning: number;
  maxQueueDepthReject: number;

  // Service URLs
  fixtureSourceUrl: string;
  adapterApiUrl: string;
  queryApiUrl: string;

  // Object Store
  objectStorePath: string;

  // LLM
  llmModelText: string;
  llmModelPdf: string;
  llmRequestTimeoutMs: number;
  openaiApiKey: string;

  // Controlled Failures (testing)
  enableControlledFailures: boolean;
  failpointLlmText: boolean;
  failpointLlmPdf: boolean;
  failpointPersist: boolean;

  // Database
  databaseUrl: string;
}

export const config: Config = {
  // Redis
  redisHost: process.env.REDIS_HOST || 'redis',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  redisUrl: process.env.REDIS_URL || 'redis://redis:6379',

  // Queue & Worker
  workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY || '5', 10),
  maxJobAttempts: parseInt(process.env.BULLMQ_DEFAULT_ATTEMPTS || '5', 10),
  backoffBaseMs: parseInt(process.env.BACKOFF_BASE_MS || '2000', 10),

  // Backpressure Controls
  maxQueueDepthWarning: parseInt(process.env.MAX_QUEUE_DEPTH_WARNING || '5000', 10),
  maxQueueDepthReject: parseInt(process.env.MAX_QUEUE_DEPTH_REJECT || '10000', 10),

  // Service URLs
  fixtureSourceUrl: process.env.FIXTURE_SOURCE_URL || 'http://fixture-source:9000',
  adapterApiUrl: process.env.ADAPTER_API_URL || 'http://adapter-api:8080',
  queryApiUrl: process.env.QUERY_API_URL || 'http://query-api:8081',

  // Object Store
  objectStorePath: process.env.OBJECT_STORE_PATH || '/object-store',

  // LLM
  llmModelText: process.env.LLM_MODEL_TEXT || 'gpt-4o-mini',
  llmModelPdf: process.env.LLM_MODEL_PDF || 'gpt-4o',
  llmRequestTimeoutMs: parseInt(process.env.LLM_REQUEST_TIMEOUT_MS || '60000', 10),
  openaiApiKey: process.env.OPENAI_API_KEY || '',

  // Controlled Failures (testing)
  enableControlledFailures: process.env.ENABLE_CONTROLLED_FAILURES === 'true',
  failpointLlmText: process.env.FAILPOINT_LLM_TEXT === 'true',
  failpointLlmPdf: process.env.FAILPOINT_LLM_PDF === 'true',
  failpointPersist: process.env.FAILPOINT_PERSIST === 'true',

  // Database
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgresql://stackpoint_user:stackpoint_pass@postgres:5432/stackpoint',
};
