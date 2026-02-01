/**
 * Fixture Source - Mock External Document API
 *
 * Serves test PDFs from the /data directory.
 * Implements the External Source API per docs/api.md.
 */

import express, { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';

const app = express();
const port = parseInt(process.env.PORT || '9000', 10);
const dataPath = process.env.DATA_PATH || '/data';

// Middleware for JSON responses
app.use(express.json());

// Request logging
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: duration,
      })
    );
  });
  next();
});

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    service: 'fixture-source',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /documents
 * Lists documents available for sync
 */
app.get('/documents', async (req: Request, res: Response) => {
  try {
    const sinceCursor = req.query.since_cursor as string | undefined;

    // Read PDF files from data directory
    const files = fs.readdirSync(dataPath).filter((f) => f.toLowerCase().endsWith('.pdf'));

    // Sort by filename for stable ordering
    files.sort();

    // Map to API response format
    const items = files.map((filename, index) => {
      const filePath = path.join(dataPath, filename);
      const stats = fs.statSync(filePath);

      return {
        source_doc_id: `doc_${String(index + 1).padStart(3, '0')}`,
        filename,
        download_url: `http://fixture-source:9000/documents/doc_${String(index + 1).padStart(3, '0')}`,
        updated_at: stats.mtime.toISOString(),
      };
    });

    // Simple cursor support - skip items before cursor
    let filteredItems = items;
    if (sinceCursor) {
      const cursorIndex = items.findIndex((i) => i.source_doc_id === sinceCursor);
      if (cursorIndex >= 0) {
        filteredItems = items.slice(cursorIndex + 1);
      }
    }

    res.json({
      items: filteredItems,
      next_cursor: filteredItems.length > 0 ? filteredItems[filteredItems.length - 1].source_doc_id : null,
    });
  } catch (error) {
    console.error('Error listing documents:', error);
    res.status(500).json({
      error: {
        code: 'internal_error',
        message: 'Failed to list documents',
      },
    });
  }
});

/**
 * GET /documents/:source_doc_id
 * Downloads the raw PDF bytes for a document
 */
app.get('/documents/:source_doc_id', async (req: Request, res: Response) => {
  try {
    const { source_doc_id } = req.params;

    // Read PDF files from data directory
    const files = fs.readdirSync(dataPath).filter((f) => f.toLowerCase().endsWith('.pdf'));
    files.sort();

    // Find the file by source_doc_id
    const docIndex = parseInt(source_doc_id.replace('doc_', ''), 10) - 1;

    if (docIndex < 0 || docIndex >= files.length) {
      res.status(404).json({
        error: {
          code: 'not_found',
          message: `Document ${source_doc_id} not found`,
        },
      });
      return;
    }

    const filename = files[docIndex];
    const filePath = path.join(dataPath, filename);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      res.status(404).json({
        error: {
          code: 'not_found',
          message: `Document ${source_doc_id} not found`,
        },
      });
      return;
    }

    // Stream the file
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Source-Filename', filename);

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (error) {
    console.error('Error downloading document:', error);
    res.status(500).json({
      error: {
        code: 'internal_error',
        message: 'Failed to download document',
      },
    });
  }
});

// Start server
app.listen(port, () => {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      message: `Fixture Source started on port ${port}`,
      dataPath,
    })
  );

  // List available documents on startup
  try {
    const files = fs.readdirSync(dataPath).filter((f) => f.toLowerCase().endsWith('.pdf'));
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        message: `Found ${files.length} PDF files`,
        files,
      })
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'WARN',
        message: `Data path not accessible: ${dataPath}`,
      })
    );
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      message: 'SIGTERM received, shutting down',
    })
  );
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      message: 'SIGINT received, shutting down',
    })
  );
  process.exit(0);
});
