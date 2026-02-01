/**
 * AsyncLocalStorage Context Management
 *
 * Provides correlation ID propagation across API requests and worker jobs
 * using Node.js AsyncLocalStorage.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { ulid } from 'ulid';

export interface RequestContext {
  correlationId: string;
  documentId?: string;
  sourceSystem?: string;
}

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Get the current request context
 */
export function getContext(): RequestContext | undefined {
  return asyncLocalStorage.getStore();
}

/**
 * Get the correlation ID from the current context, or generate a new one
 */
export function getCorrelationId(): string {
  const context = getContext();
  return context?.correlationId || ulid();
}

/**
 * Run a function within a new AsyncLocalStorage context
 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return asyncLocalStorage.run(context, fn);
}

/**
 * Run an async function within a new AsyncLocalStorage context
 */
export async function runWithContextAsync<T>(
  context: RequestContext,
  fn: () => Promise<T>
): Promise<T> {
  return asyncLocalStorage.run(context, fn);
}

export { asyncLocalStorage };
