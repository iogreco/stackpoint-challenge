/**
 * PDF Text Extraction
 *
 * Extracts text from PDF files using pdfjs-dist.
 */

import fs from 'fs';
import path from 'path';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { logger } from '@stackpoint/shared';

// Configure worker for Node.js environment
const workerPath = path.join(
  path.dirname(require.resolve('pdfjs-dist/package.json')),
  'legacy/build/pdf.worker.mjs'
);
pdfjsLib.GlobalWorkerOptions.workerSrc = workerPath;

export interface PageText {
  pageNumber: number;
  text: string;
}

export interface PdfTextResult {
  pages: PageText[];
  totalPages: number;
  combinedText: string;
}

/**
 * Extract text from a PDF file, preserving line structure.
 *
 * Groups text items by Y position to maintain document layout.
 * This is critical for the LLM to distinguish between sections
 * (e.g., employer header vs employee info on a paystub).
 */
export async function extractTextFromPdf(filePath: string): Promise<PdfTextResult> {
  logger.info('Extracting text from PDF', { filePath });

  const data = new Uint8Array(fs.readFileSync(filePath));
  const pdf = await pdfjsLib.getDocument({ data }).promise;

  const pages: PageText[] = [];
  let combinedText = '';

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();

    // Group text items by Y position to preserve line structure
    const itemsByY: Record<number, Array<{ x: number; str: string }>> = {};

    for (const item of textContent.items as any[]) {
      if (!item.str || item.str.trim() === '') continue;

      // Round Y position to group items on the same line
      // (text on the same visual line may have slight Y variations)
      const y = Math.round(item.transform[5]);
      const x = Math.round(item.transform[4]);

      if (!itemsByY[y]) {
        itemsByY[y] = [];
      }
      itemsByY[y].push({ x, str: item.str });
    }

    // Sort Y positions descending (top to bottom on page)
    const sortedYPositions = Object.keys(itemsByY)
      .map(Number)
      .sort((a, b) => b - a);

    // Build page text with line breaks preserved
    const lines: string[] = [];
    for (const y of sortedYPositions) {
      // Sort items on same line by X position (left to right)
      const lineItems = itemsByY[y].sort((a, b) => a.x - b.x);
      const lineText = lineItems.map((item) => item.str).join(' ').trim();
      if (lineText) {
        lines.push(lineText);
      }
    }

    const pageText = lines.join('\n');

    pages.push({
      pageNumber: pageNum,
      text: pageText,
    });

    combinedText += `--- Page ${pageNum} ---\n${pageText}\n\n`;
  }

  logger.info('PDF text extraction complete', {
    filePath,
    totalPages: pdf.numPages,
    totalChars: combinedText.length,
  });

  return {
    pages,
    totalPages: pdf.numPages,
    combinedText,
  };
}
