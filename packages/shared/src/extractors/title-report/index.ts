/**
 * Title Report Extractor
 *
 * Skip extraction for title report documents.
 * Title reports contain property title history and ownership chain,
 * NOT borrower-relevant data for fact extraction.
 */

import { SkipExtractor } from '../base-extractor';
import { TITLE_REPORT_TEMPLATE } from '../../templates/title-report.template';

/**
 * Title report extractor using skip strategy.
 * Returns empty facts as title reports don't contain borrower data.
 */
export class TitleReportExtractor extends SkipExtractor {
  constructor() {
    super(TITLE_REPORT_TEMPLATE);
  }
}

export const titleReportExtractor = new TitleReportExtractor();
