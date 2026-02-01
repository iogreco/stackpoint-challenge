/**
 * Adapter API
 *
 * POST /sync - Triggers document sync from external source
 */

import express, { Request, Response, NextFunction } from 'express';
import { ulid } from 'ulid';
import {
  logger,
  runWithContext,
  getMetrics,
  getMetricsContentType,
  httpRequestDurationHistogram,
  httpRequestsCounter,
  backpressureRejectionsCounter,
  createQueue,
  checkBackpressure,
  QUEUE_NAMES,
  type DocumentAvailableJob,
  type SyncRequest,
  type ErrorEnvelope,
} from '@stackpoint/shared';
import { syncDocuments } from './lib/sync';

const app = express();
const port = parseInt(process.env.PORT || '8080', 10);

// Create the document_available queue
const documentAvailableQueue = createQueue<DocumentAvailableJob, void>(
  QUEUE_NAMES.DOCUMENT_AVAILABLE
);

// Middleware
app.use(express.json());

// Correlation ID middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const correlationId = (req.headers['x-correlation-id'] as string) || ulid();
  res.setHeader('X-Correlation-Id', correlationId);

  runWithContext({ correlationId }, () => {
    next();
  });
});

// Request timing middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const path = req.route?.path || req.path;

    httpRequestDurationHistogram.observe(
      { method: req.method, path, status: res.statusCode.toString() },
      duration
    );
    httpRequestsCounter.inc({
      method: req.method,
      path,
      status: res.statusCode.toString(),
    });

    logger.info('Request completed', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Math.round(duration * 1000),
    });
  });

  next();
});

// Health check
app.get('/health', async (req: Request, res: Response) => {
  try {
    // Check Redis connection via queue
    const metrics = await checkBackpressure(documentAvailableQueue);

    res.json({
      status: 'healthy',
      service: 'adapter-api',
      queue_depth: metrics.depth,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      service: 'adapter-api',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
});

// Metrics endpoint
app.get('/metrics', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', getMetricsContentType());
  res.send(await getMetrics());
});

/**
 * POST /sync
 * Triggers a sync pass against the external source
 */
app.post('/sync', async (req: Request, res: Response) => {
  const correlationId = res.getHeader('X-Correlation-Id') as string;

  try {
    // Validate request body
    const body = req.body as Partial<SyncRequest>;

    if (!body.source_system) {
      const error: ErrorEnvelope = {
        error: {
          code: 'invalid_request',
          message: 'source_system is required',
          correlation_id: correlationId,
        },
      };
      res.status(400).json(error);
      return;
    }

    const syncRequest: SyncRequest = {
      source_system: body.source_system,
      since_cursor: body.since_cursor || null,
      max_documents: body.max_documents || 50,
    };

    // Check backpressure
    const backpressure = await checkBackpressure(documentAvailableQueue);

    if (backpressure.shouldReject) {
      backpressureRejectionsCounter.inc();
      logger.warn('Request rejected due to backpressure', {
        queue_depth: backpressure.depth,
      });

      const error: ErrorEnvelope = {
        error: {
          code: 'service_unavailable',
          message: 'System is under heavy load. Please retry later.',
          correlation_id: correlationId,
        },
      };
      res.status(503).json(error);
      return;
    }

    if (backpressure.shouldWarn) {
      logger.warn('Queue depth approaching threshold', {
        queue_depth: backpressure.depth,
      });
    }

    // Perform sync
    logger.info('Starting sync', {
      source_system: syncRequest.source_system,
      max_documents: syncRequest.max_documents,
    });

    await syncDocuments(syncRequest, correlationId, documentAvailableQueue);

    logger.info('Sync initiated', {
      source_system: syncRequest.source_system,
    });

    res.status(202).json({
      correlation_id: correlationId,
    });
  } catch (error) {
    logger.error('Sync failed', error);

    const errorResponse: ErrorEnvelope = {
      error: {
        code: error instanceof Error && error.message.includes('external') ? 'bad_gateway' : 'internal_error',
        message: error instanceof Error ? error.message : 'Unknown error',
        correlation_id: correlationId,
      },
    };

    const statusCode = error instanceof Error && error.message.includes('external') ? 502 : 500;
    res.status(statusCode).json(errorResponse);
  }
});

// Start server
app.listen(port, () => {
  logger.info('Adapter API started', { port });
});

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  await documentAvailableQueue.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
