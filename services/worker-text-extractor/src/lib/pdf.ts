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
 * Extract text from a PDF file
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

    const pageText = textContent.items
      .map((item: any) => item.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

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
