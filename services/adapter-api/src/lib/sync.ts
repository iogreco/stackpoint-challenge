/**
 * Sync Logic
 *
 * Lists documents from external source, downloads PDFs, stores to object store,
 * and enqueues document.available jobs.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Queue } from 'bullmq';
import {
  logger,
  config,
  type SyncRequest,
  type DocumentAvailableJob,
  type ExternalDocumentItem,
  type ExternalDocumentListResponse,
} from '@stackpoint/shared';

const objectStorePath = process.env.OBJECT_STORE_PATH || config.objectStorePath;
const fixtureSourceUrl = process.env.FIXTURE_SOURCE_URL || config.fixtureSourceUrl;

/**
 * Sync documents from external source
 */
export async function syncDocuments(
  request: SyncRequest,
  correlationId: string,
  queue: Queue<DocumentAvailableJob, void>
): Promise<void> {
  // Step 1: List documents from external source
  const listUrl = new URL('/documents', fixtureSourceUrl);
  if (request.since_cursor) {
    listUrl.searchParams.set('since_cursor', request.since_cursor);
  }

  logger.info('Listing documents from external source', {
    url: listUrl.toString(),
  });

  const listResponse = await fetch(listUrl.toString());

  if (!listResponse.ok) {
    throw new Error(`External source list failed: ${listResponse.status} ${listResponse.statusText}`);
  }

  const listData = (await listResponse.json()) as ExternalDocumentListResponse;

  logger.info('Found documents', {
    count: listData.items.length,
    next_cursor: listData.next_cursor,
  });

  // Limit to max_documents
  const documentsToProcess = listData.items.slice(0, request.max_documents || 50);

  // Step 2: Process each document
  for (const doc of documentsToProcess) {
    try {
      await processDocument(doc, request.source_system, correlationId, queue);
    } catch (error) {
      logger.error('Failed to process document', error, {
        source_doc_id: doc.source_doc_id,
        filename: doc.filename,
      });
      // Continue processing other documents
    }
  }
}

/**
 * Process a single document: download, store, and enqueue
 */
async function processDocument(
  doc: ExternalDocumentItem,
  sourceSystem: string,
  correlationId: string,
  queue: Queue<DocumentAvailableJob, void>
): Promise<void> {
  logger.info('Processing document', {
    source_doc_id: doc.source_doc_id,
    filename: doc.filename,
  });

  // Step 1: Download PDF bytes
  const downloadResponse = await fetch(doc.download_url);

  if (!downloadResponse.ok) {
    throw new Error(`Download failed: ${downloadResponse.status} ${downloadResponse.statusText}`);
  }

  const pdfBytes = Buffer.from(await downloadResponse.arrayBuffer());

  // Step 2: Compute document_id as sha256 hash
  const hash = crypto.createHash('sha256');
  hash.update(pdfBytes);
  const documentId = `sha256:${hash.digest('hex')}`;

  // Step 3: Store to object store
  const rawDir = path.join(objectStorePath, 'raw', sourceSystem);

  // Ensure directory exists
  if (!fs.existsSync(rawDir)) {
    fs.mkdirSync(rawDir, { recursive: true });
  }

  const pdfPath = path.join(rawDir, `${documentId.replace('sha256:', '')}.pdf`);
  fs.writeFileSync(pdfPath, pdfBytes);

  const rawUri = `file://${pdfPath}`;

  logger.info('Stored document', {
    document_id: documentId,
    raw_uri: rawUri,
    size_bytes: pdfBytes.length,
  });

  // Step 4: Enqueue document.available job
  const jobPayload: DocumentAvailableJob = {
    event_type: 'document.available',
    correlation_id: correlationId,
    document_id: documentId,
    raw_uri: rawUri,
    source_system: sourceSystem,
    source_doc_id: doc.source_doc_id,
    source_filename: doc.filename,
    discovered_at: new Date().toISOString(),
  };

  await queue.add('document.available', jobPayload, {
    jobId: `${sourceSystem}_${documentId.replace(':', '_')}`,
  });

  logger.info('Enqueued document.available job', {
    document_id: documentId,
    source_doc_id: doc.source_doc_id,
  });
}
