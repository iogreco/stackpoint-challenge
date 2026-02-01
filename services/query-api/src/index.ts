/**
 * Query API
 *
 * Read-only API for borrower and application records.
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
  validateBorrower,
  validateApplication,
  type ErrorEnvelope,
  type BorrowerListResponse,
} from '@stackpoint/shared';
import {
  getBorrowerById,
  searchBorrowers,
  getApplicationByLoanNumber,
  pool,
} from './lib/db';

const app = express();
const port = parseInt(process.env.PORT || '8081', 10);

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
    // Test database connection
    await pool.query('SELECT 1');

    res.json({
      status: 'healthy',
      service: 'query-api',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      service: 'query-api',
      database: 'disconnected',
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
 * GET /borrowers/:borrower_id
 * Returns the borrower record for a single borrower
 */
app.get('/borrowers/:borrower_id', async (req: Request, res: Response) => {
  const correlationId = res.getHeader('X-Correlation-Id') as string;
  const { borrower_id } = req.params;

  try {
    const record = await getBorrowerById(borrower_id);

    if (!record) {
      const error: ErrorEnvelope = {
        error: {
          code: 'not_found',
          message: `Borrower ${borrower_id} not found`,
          correlation_id: correlationId,
        },
      };
      res.status(404).json(error);
      return;
    }

    // Validate response
    const validation = validateBorrower(record);
    if (!validation.valid) {
      logger.warn('BorrowerRecord validation failed', { errors: validation.errors });
    }

    res.json(record);
  } catch (error) {
    logger.error('Failed to get borrower', error, { borrower_id });

    const errorResponse: ErrorEnvelope = {
      error: {
        code: 'internal_error',
        message: 'Failed to retrieve borrower',
        correlation_id: correlationId,
      },
    };
    res.status(500).json(errorResponse);
  }
});

/**
 * GET /borrowers
 * Search + pagination for borrowers
 */
app.get('/borrowers', async (req: Request, res: Response) => {
  const correlationId = res.getHeader('X-Correlation-Id') as string;

  try {
    const name = req.query.name as string | undefined;
    const zip = req.query.zip as string | undefined;
    const status = req.query.status as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const cursor = req.query.cursor as string | undefined;

    // Validate status parameter
    if (status && !['COMPLETE', 'PARTIAL'].includes(status)) {
      const error: ErrorEnvelope = {
        error: {
          code: 'invalid_request',
          message: 'status must be COMPLETE or PARTIAL',
          correlation_id: correlationId,
        },
      };
      res.status(400).json(error);
      return;
    }

    const result = await searchBorrowers({ name, zip, status }, limit, cursor);

    const response: BorrowerListResponse = {
      items: result.items,
      next_cursor: result.next_cursor,
    };

    res.json(response);
  } catch (error) {
    logger.error('Failed to search borrowers', error);

    const errorResponse: ErrorEnvelope = {
      error: {
        code: 'internal_error',
        message: 'Failed to search borrowers',
        correlation_id: correlationId,
      },
    };
    res.status(500).json(errorResponse);
  }
});

/**
 * GET /applications/by-loan/:loan_number
 * Returns the application for a loan number
 */
app.get('/applications/by-loan/:loan_number', async (req: Request, res: Response) => {
  const correlationId = res.getHeader('X-Correlation-Id') as string;
  const { loan_number } = req.params;

  try {
    const record = await getApplicationByLoanNumber(loan_number);

    if (!record) {
      const error: ErrorEnvelope = {
        error: {
          code: 'not_found',
          message: `Application with loan number ${loan_number} not found`,
          correlation_id: correlationId,
        },
      };
      res.status(404).json(error);
      return;
    }

    // Validate response
    const validation = validateApplication(record);
    if (!validation.valid) {
      logger.warn('ApplicationRecord validation failed', { errors: validation.errors });
    }

    res.json(record);
  } catch (error) {
    logger.error('Failed to get application', error, { loan_number });

    const errorResponse: ErrorEnvelope = {
      error: {
        code: 'internal_error',
        message: 'Failed to retrieve application',
        correlation_id: correlationId,
      },
    };
    res.status(500).json(errorResponse);
  }
});

// Start server
app.listen(port, () => {
  logger.info('Query API started', { port });
});

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
