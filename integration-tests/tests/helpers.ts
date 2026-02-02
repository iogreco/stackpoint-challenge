/**
 * Test Helpers
 *
 * Utilities for E2E testing.
 */

const ADAPTER_API_URL = process.env.ADAPTER_API_URL || 'http://localhost:8080';
const QUERY_API_URL = process.env.QUERY_API_URL || 'http://localhost:8081';

/**
 * Wait for service health
 */
export async function waitForHealth(
  url: string,
  maxWaitMs: number = 30000
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) {
        return true;
      }
    } catch {
      // Service not ready yet
    }

    await sleep(1000);
  }

  return false;
}

/**
 * Trigger sync and wait for completion
 */
export async function syncAndWait(
  sourceSystem: string,
  maxDocuments: number = 1,
  maxWaitMs: number = 60000
): Promise<{ correlationId: string; success: boolean }> {
  // Trigger sync
  const syncResponse = await fetch(`${ADAPTER_API_URL}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_system: sourceSystem,
      max_documents: maxDocuments,
    }),
  });

  if (!syncResponse.ok) {
    throw new Error(`Sync failed: ${syncResponse.status}`);
  }

  const syncData = await syncResponse.json() as { correlation_id: string };
  const correlationId = syncData.correlation_id;

  // Wait for processing to complete
  // In a real implementation, we would poll queue depth or check for documents
  await sleep(maxWaitMs);

  return { correlationId, success: true };
}

/**
 * Get borrowers from Query API
 */
export async function getBorrowers(
  filters: { name?: string; zip?: string; status?: string } = {}
): Promise<any[]> {
  const params = new URLSearchParams();
  if (filters.name) params.set('name', filters.name);
  if (filters.zip) params.set('zip', filters.zip);
  if (filters.status) params.set('status', filters.status);

  const url = `${QUERY_API_URL}/borrowers${params.toString() ? '?' + params.toString() : ''}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Get borrowers failed: ${response.status}`);
  }

  const data = await response.json() as { items: any[] };
  return data.items;
}

/**
 * Get borrower by ID
 */
export async function getBorrowerById(borrowerId: string): Promise<any | null> {
  const response = await fetch(`${QUERY_API_URL}/borrowers/${borrowerId}`);

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Get borrower failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Get application by loan number
 */
export async function getApplicationByLoanNumber(loanNumber: string): Promise<any | null> {
  const response = await fetch(`${QUERY_API_URL}/applications/by-loan/${loanNumber}`);

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Get application failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Sleep helper
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripEvidenceAndConfidence(obj: any): void {
  for (const arr of [obj.addresses, obj.income_history, obj.identifiers, obj.applications]) {
    if (Array.isArray(arr)) {
      for (const item of arr) {
        delete item.confidence;
        if (Array.isArray(item.evidence)) {
          for (const e of item.evidence) delete e.evidence_source_context;
        }
      }
    }
  }
  if (obj.property_address) {
    delete obj.property_address.confidence;
    if (Array.isArray(obj.property_address.evidence)) {
      for (const e of obj.property_address.evidence) delete e.evidence_source_context;
    }
  }
  if (Array.isArray(obj.identifiers)) {
    for (const item of obj.identifiers) {
      delete item.confidence;
      if (Array.isArray(item.evidence)) {
        for (const e of item.evidence) delete e.evidence_source_context;
      }
    }
  }
}

/**
 * Strip volatile fields from object for comparison
 */
export function stripVolatileFields(obj: any, type: 'borrower' | 'application' | 'extraction'): any {
  const copy = JSON.parse(JSON.stringify(obj));

  if (type === 'borrower') {
    delete copy.borrower_id;
    delete copy.updated_at;
    delete copy.last_correlation_id;
    if (copy.documents) {
      for (const doc of copy.documents) {
        delete doc.correlation_id;
        delete doc.processed_at;
        delete doc.raw_uri;
      }
    }
    stripEvidenceAndConfidence(copy);
  } else if (type === 'application') {
    delete copy.application_id;
    delete copy.updated_at;
    if (copy.documents) {
      for (const doc of copy.documents) {
        delete doc.correlation_id;
        delete doc.processed_at;
        delete doc.raw_uri;
      }
    }
    stripEvidenceAndConfidence(copy);
  } else if (type === 'extraction') {
    delete copy.correlation_id;
    delete copy.created_at;
    delete copy.document?.raw_uri;
    if (copy.extraction_metadata) {
      delete copy.extraction_metadata.request_id;
    }
  }

  return copy;
}

/**
 * Normalize arrays for stable comparison
 */
export function normalizeForComparison(obj: any): any {
  const copy = JSON.parse(JSON.stringify(obj));

  // Sort arrays by stable keys
  if (copy.addresses) {
    copy.addresses.sort((a: any, b: any) => {
      return `${a.type}|${a.zip}`.localeCompare(`${b.type}|${b.zip}`);
    });
  }

  if (copy.income_history) {
    copy.income_history.sort((a: any, b: any) => {
      return `${a.period_year}|${a.source_type}|${a.amount}`.localeCompare(
        `${b.period_year}|${b.source_type}|${b.amount}`
      );
    });
  }

  if (copy.identifiers) {
    copy.identifiers.sort((a: any, b: any) => {
      return `${a.type}|${a.value}`.localeCompare(`${b.type}|${b.value}`);
    });
  }

  if (copy.documents) {
    copy.documents.sort((a: any, b: any) => {
      return `${a.document_id}`.localeCompare(`${b.document_id}`);
    });
  }

  return copy;
}
