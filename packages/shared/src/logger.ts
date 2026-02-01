/**
 * Structured Logging with Correlation IDs
 *
 * All logs automatically include correlation IDs from AsyncLocalStorage context
 */

import { getCorrelationId, getContext } from './context';

export interface LogContext {
  [key: string]: unknown;
}

function formatLog(level: string, message: string, context?: LogContext): string {
  const correlationId = getCorrelationId();
  const timestamp = new Date().toISOString();
  const reqContext = getContext();

  const logEntry = {
    timestamp,
    level,
    correlationId,
    documentId: reqContext?.documentId,
    sourceSystem: reqContext?.sourceSystem,
    message,
    ...context,
  };

  return JSON.stringify(logEntry);
}

export const logger = {
  info: (message: string, context?: LogContext) => {
    console.log(formatLog('INFO', message, context));
  },

  warn: (message: string, context?: LogContext) => {
    console.warn(formatLog('WARN', message, context));
  },

  error: (message: string, error?: Error | unknown, context?: LogContext) => {
    const errorContext = {
      ...context,
      error:
        error instanceof Error
          ? {
              message: error.message,
              stack: error.stack,
              name: error.name,
            }
          : String(error),
    };
    console.error(formatLog('ERROR', message, errorContext));
  },

  debug: (message: string, context?: LogContext) => {
    if (process.env.LOG_LEVEL === 'debug' || process.env.NODE_ENV !== 'production') {
      console.debug(formatLog('DEBUG', message, context));
    }
  },
};
