import { Injectable } from '@angular/core';
import * as XLSX from 'xlsx';
import {
  NewspaperData,
  NewspaperEdition,
  NewspaperPage,
  NewsSection,
  XmlImportRow,
  XmlImportResult,
  XmlImportSummary,
  XmlParseError,
} from '../services/newspaper-data.service';

/** Tags whose presence in imported HTML content must be stripped for security. */
const BLOCKED_TAGS = new Set(['script', 'iframe', 'style', 'object', 'embed', 'form', 'input', 'button']);

/**
 * Recognised column header names (lowercase) → canonical field key.
 * Allows flexible column naming: "Post Title", "TITLE", "title" all map to 'title'.
 */
const EXCEL_COLUMN_MAP: Record<string, keyof ExcelColIndex> = {
  title: 'title', 'post title': 'title', 'headline': 'title',
  content: 'content', body: 'content', 'post body': 'content', 'post content': 'content',
  date: 'date', 'publish date': 'date', 'publication date': 'date',
  edition: 'edition', 'edition number': 'edition', 'ed': 'edition',
  page: 'page', 'page number': 'page', 'page no': 'page', 'page no.': 'page',
};

interface ExcelColIndex {
  title: number;
  content: number;
  date: number;
  edition: number;
  page: number;
}

@Injectable({ providedIn: 'root' })
export class XmlImportService {

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Step 1: Parse raw XML string into structured rows.
   * Uses the browser-native DOMParser — no external library required.
   */
  parseXml(xmlString: string): XmlImportResult {
    const errors: XmlParseError[] = [];
    const rows: XmlImportRow[] = [];

    // Parse the XML document
    let doc: Document;
    try {
      doc = new DOMParser().parseFromString(xmlString, 'application/xml');
    } catch (e) {
      errors.push({ rowIndex: -1, field: 'xml', message: 'Failed to parse XML document.', severity: 'error' });
      return this.buildResult(rows, errors);
    }

    // Check for XML parse errors (parsererror is the browser standard)
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      errors.push({
        rowIndex: -1,
        field: 'xml',
        message: `Malformed XML: ${parseError.textContent?.trim().substring(0, 200) || 'unknown parse error'}`,
        severity: 'error',
      });
      return this.buildResult(rows, errors);
    }

    const postElements = Array.from(doc.querySelectorAll('newspaper > post'));
    if (postElements.length === 0) {
      errors.push({ rowIndex: -1, field: 'xml', message: 'No <post> elements found inside <newspaper> root.', severity: 'error' });
      return this.buildResult(rows, errors);
    }

    // seenBaseIds: base IDs (pre-counter) used to detect intra-file duplicates and emit warnings
    // seenIds: final assigned IDs (with counter suffix) to ensure uniqueness within the file
    const seenBaseIds = new Set<string>();
    const seenIds = new Set<string>();

    postElements.forEach((el, rowIndex) => {
      const rowErrors: XmlParseError[] = [];

      const rawTitle = this.getText(el, 'title');
      const rawContent = this.getText(el, 'content');
      const rawDate = this.getText(el, 'date');
      const rawEdition = this.getText(el, 'edition');
      const rawPage = this.getText(el, 'page');

      // ── Field validation ──────────────────────────────────────────────────

      // title (required)
      const title = rawTitle.replace(/<[^>]*>/g, '').trim().substring(0, 255);
      if (!title) {
        rowErrors.push({ rowIndex, field: 'title', message: 'Missing or empty <title>.', severity: 'error' });
      }

      // date (required, must be YYYY-MM-DD)
      let date = rawDate.trim();
      if (!date) {
        rowErrors.push({ rowIndex, field: 'date', message: 'Missing <date>.', severity: 'error' });
        date = '';
      } else if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) {
        rowErrors.push({ rowIndex, field: 'date', message: `Invalid date "${date}" — expected YYYY-MM-DD.`, severity: 'error' });
        date = '';
      }

      // edition (optional, defaults to 1)
      let edition = 1;
      if (rawEdition.trim()) {
        const parsed = parseInt(rawEdition.trim(), 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          rowErrors.push({ rowIndex, field: 'edition', message: `Invalid edition "${rawEdition}" — must be an integer ≥ 1. Defaulting to 1.`, severity: 'warning' });
        } else {
          edition = parsed;
        }
      }

      // page (required, integer ≥ 1)
      let page = 0;
      if (!rawPage.trim()) {
        rowErrors.push({ rowIndex, field: 'page', message: 'Missing <page>.', severity: 'error' });
      } else {
        const parsed = parseInt(rawPage.trim(), 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          rowErrors.push({ rowIndex, field: 'page', message: `Invalid page "${rawPage}" — must be an integer ≥ 1.`, severity: 'error' });
        } else {
          page = parsed;
        }
      }

      // If fatal errors on this row, record them and skip
      const hasFatal = rowErrors.some(e => e.severity === 'error');
      errors.push(...rowErrors);
      if (hasFatal) return;

      // ── Sanitize content ─────────────────────────────────────────────────
      const sanitizedContent = this.sanitizeHtml(rawContent);

      // ── Derive deterministic section ID ──────────────────────────────────
      // Compute the base ID first (without counter) to detect intra-file duplicates.
      const baseId = this.deriveBaseId({ title, date, edition, page });
      const isIntraFileDuplicate = seenBaseIds.has(baseId);
      seenBaseIds.add(baseId);

      if (isIntraFileDuplicate) {
        errors.push({
          rowIndex,
          field: 'id',
          message: `Duplicate within this file — row ${rowIndex + 1} has the same title/date/edition/page as an earlier row. Only the first occurrence will be imported.`,
          severity: 'warning',
        });
      }

      // Always derive a unique final ID (counter suffix prevents storage collisions).
      const derivedId = this.deriveXmlSectionId({ title, date, edition, page }, seenIds);

      const row: XmlImportRow = {
        title,
        content: sanitizedContent,
        date,
        edition,
        page,
        derivedId,
        duplicateStatus: isIntraFileDuplicate ? 'duplicate-exact' : 'new',
        importAction: isIntraFileDuplicate ? 'skip' : 'import-as-new',
        assignedPageId: page,
        rowIndex,
        rawTitle: rawTitle.trim(),
      };

      rows.push(row);
    });

    return this.buildResult(rows, errors);
  }

  /**
   * Step 1b: Parse an Excel (xlsx/xls) or CSV ArrayBuffer into structured rows.
   * Expects row 1 to be a header row with recognised column names.
   * The output shape is identical to parseXml() so the rest of the wizard is format-agnostic.
   */
  parseExcel(buffer: ArrayBuffer): XmlImportResult {
    const errors: XmlParseError[] = [];
    const rows: XmlImportRow[] = [];

    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
    } catch (e) {
      errors.push({ rowIndex: -1, field: 'file', message: 'Could not read file — make sure it is a valid .xlsx, .xls or .csv file.', severity: 'error' });
      return this.buildResult(rows, errors);
    }

    if (workbook.SheetNames.length === 0) {
      errors.push({ rowIndex: -1, field: 'file', message: 'The workbook contains no sheets.', severity: 'error' });
      return this.buildResult(rows, errors);
    }

    // ── Find the best sheet ───────────────────────────────────────────────────
    // Prefer a sheet explicitly named "Posts", then fall back to the first sheet
    // whose first row contains at least two of the recognised header column names.
    // This handles Apple Numbers / Google Sheets exports that prepend a metadata sheet.
    const findDataSheet = (): string | null => {
      // 1. Exact name match
      const preferred = ['Posts', 'Sheet1', 'Sheet 1', 'Data'];
      for (const name of preferred) {
        if (workbook.SheetNames.includes(name)) return name;
      }
      // 2. First sheet whose header row has ≥ 2 recognised columns
      for (const name of workbook.SheetNames) {
        const ws = workbook.Sheets[name];
        const firstRow = (XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', range: 0 }) as unknown[][])[0] ?? [];
        const matches = (firstRow as string[]).filter(
          cell => EXCEL_COLUMN_MAP[String(cell ?? '').toLowerCase().trim()]
        ).length;
        if (matches >= 2) return name;
      }
      return null;
    };

    const sheetName = findDataSheet();
    if (!sheetName) {
      errors.push({
        rowIndex: -1,
        field: 'file',
        message: `Could not find a data sheet. Make sure one sheet has a header row with at least Title, Date, and Page columns. Sheet names found: ${workbook.SheetNames.join(', ')}`,
        severity: 'error',
      });
      return this.buildResult(rows, errors);
    }

    // sheet_to_json with header:1 gives array-of-arrays; first row is the header
    const raw: unknown[][] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });

    if (raw.length < 2) {
      errors.push({ rowIndex: -1, field: 'file', message: 'The sheet has no data rows (at least a header row + one data row are required).', severity: 'error' });
      return this.buildResult(rows, errors);
    }

    // ── Map header row to column indices ──────────────────────────────────────
    const headerRow = raw[0] as string[];
    const colIndex: Partial<ExcelColIndex> = {};

    headerRow.forEach((cell, i) => {
      const key = String(cell ?? '').toLowerCase().trim();
      const mapped = EXCEL_COLUMN_MAP[key];
      if (mapped && colIndex[mapped] === undefined) {
        colIndex[mapped] = i;
      }
    });

    // title, date, page are required columns
    const missingCols: string[] = [];
    if (colIndex.title === undefined) missingCols.push('Title');
    if (colIndex.date === undefined) missingCols.push('Date');
    if (colIndex.page === undefined) missingCols.push('Page');

    if (missingCols.length > 0) {
      errors.push({
        rowIndex: -1,
        field: 'header',
        message: `Missing required column(s): ${missingCols.join(', ')}. Row 1 must be a header row with at least Title, Date, and Page columns.`,
        severity: 'error',
      });
      return this.buildResult(rows, errors);
    }

    // ── Parse data rows (index 1+) ────────────────────────────────────────────
    const seenBaseIds = new Set<string>();
    const seenIds = new Set<string>();

    for (let rowIndex = 0; rowIndex < raw.length - 1; rowIndex++) {
      const dataRow = raw[rowIndex + 1] as unknown[]; // offset by 1 (header is row 0)
      const rowErrors: XmlParseError[] = [];

      const cellStr = (col: number | undefined): string =>
        col !== undefined ? String(dataRow[col] ?? '').trim() : '';

      // title
      const rawTitle = cellStr(colIndex.title);
      const title = rawTitle.replace(/<[^>]*>/g, '').trim().substring(0, 255);
      if (!title) {
        rowErrors.push({ rowIndex, field: 'Title', message: 'Missing or empty Title.', severity: 'error' });
      }

      // date — SheetJS may parse dates as JS Date objects (cellDates:true) or leave as string
      let date = '';
      const rawDateCell = colIndex.date !== undefined ? dataRow[colIndex.date] : '';
      if (rawDateCell instanceof Date) {
        // Convert JS Date to YYYY-MM-DD using local timezone
        const y = rawDateCell.getFullYear();
        const m = String(rawDateCell.getMonth() + 1).padStart(2, '0');
        const d = String(rawDateCell.getDate()).padStart(2, '0');
        date = `${y}-${m}-${d}`;
      } else {
        // Handle ISO strings like "2026-06-04T00:00:00.000Z" by taking just the date part
        date = String(rawDateCell ?? '').trim().substring(0, 10);
      }

      if (!date) {
        rowErrors.push({ rowIndex, field: 'Date', message: 'Missing Date.', severity: 'error' });
        date = '';
      } else if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) {
        rowErrors.push({ rowIndex, field: 'Date', message: `Invalid date "${date}" — use YYYY-MM-DD format (e.g. 2026-06-04).`, severity: 'error' });
        date = '';
      }

      // edition (optional, default 1)
      let edition = 1;
      const rawEdition = cellStr(colIndex.edition);
      if (rawEdition) {
        const parsed = parseInt(rawEdition, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          rowErrors.push({ rowIndex, field: 'Edition', message: `Invalid Edition "${rawEdition}" — must be a number ≥ 1. Defaulting to 1.`, severity: 'warning' });
        } else {
          edition = parsed;
        }
      }

      // page
      let page = 0;
      const rawPage = cellStr(colIndex.page);
      if (!rawPage) {
        rowErrors.push({ rowIndex, field: 'Page', message: 'Missing Page number.', severity: 'error' });
      } else {
        const parsed = parseInt(rawPage, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          rowErrors.push({ rowIndex, field: 'Page', message: `Invalid Page "${rawPage}" — must be a number ≥ 1.`, severity: 'error' });
        } else {
          page = parsed;
        }
      }

      // Skip rows that are completely empty (trailing blank rows are common in Excel)
      if (!rawTitle && !date && !rawPage) continue;

      const hasFatal = rowErrors.some(e => e.severity === 'error');
      errors.push(...rowErrors);
      if (hasFatal) continue;

      // content (optional)
      const rawContent = cellStr(colIndex.content);
      const sanitizedContent = rawContent ? this.sanitizeHtml(rawContent) : '';

      // intra-file duplicate detection
      const baseId = this.deriveBaseId({ title, date, edition, page });
      const isIntraFileDuplicate = seenBaseIds.has(baseId);
      seenBaseIds.add(baseId);

      if (isIntraFileDuplicate) {
        errors.push({
          rowIndex,
          field: 'id',
          message: `Duplicate within this file — row ${rowIndex + 2} has the same Title/Date/Edition/Page as an earlier row. Only the first occurrence will be imported.`,
          severity: 'warning',
        });
      }

      const derivedId = this.deriveXmlSectionId({ title, date, edition, page }, seenIds);

      rows.push({
        title,
        content: sanitizedContent,
        date,
        edition,
        page,
        derivedId,
        duplicateStatus: isIntraFileDuplicate ? 'duplicate-exact' : 'new',
        importAction: isIntraFileDuplicate ? 'skip' : 'import-as-new',
        assignedPageId: page,
        rowIndex,
        rawTitle,
      });
    }

    return this.buildResult(rows, errors);
  }

  /**
   * Step 2: Detect duplicates against current data.
   * Updates duplicateStatus and importAction on each row in-place.
   * Returns the mutated rows array.
   */
  detectDuplicates(rows: XmlImportRow[], currentData: NewspaperData): XmlImportRow[] {
    // Build a map of existing sectionId → section for quick lookup
    const existingSections = new Map<string, NewsSection>();
    for (const edition of currentData.editions) {
      for (const page of edition.pages) {
        for (const section of page.sections) {
          existingSections.set(section.id, section);
        }
      }
    }

    return rows.map(row => {
      if (row.duplicateStatus !== 'new') {
        // Already flagged as intra-file duplicate — leave untouched
        return row;
      }

      const existing = existingSections.get(row.derivedId);
      if (!existing) {
        return row; // genuinely new
      }

      const contentMatch =
        existing.title.trim() === row.title.trim() &&
        existing.content.trim() === row.content.trim();

      if (contentMatch) {
        return { ...row, duplicateStatus: 'duplicate-exact', importAction: 'skip' };
      } else {
        return { ...row, duplicateStatus: 'duplicate-key', importAction: 'overwrite' };
      }
    });
  }

  /**
   * Step 3: Apply import — pure function, returns mutated data without saving.
   * Caller is responsible for calling saveData() after reviewing the result.
   */
  applyXmlImport(
    rows: XmlImportRow[],
    currentData: NewspaperData,
  ): { data: NewspaperData; summary: XmlImportSummary } {
    const summary: XmlImportSummary = { created: 0, updated: 0, skipped: 0, skeletonPagesCreated: 0 };

    // Work on a deep-ish clone so we don't mutate the live store
    let data: NewspaperData = {
      ...currentData,
      editions: currentData.editions.map(ed => ({
        ...ed,
        pages: ed.pages.map(pg => ({
          ...pg,
          sections: [...pg.sections],
        })),
      })),
    };

    // Group rows by date+edition
    const grouped = new Map<string, XmlImportRow[]>();
    for (const row of rows) {
      const key = `${row.date}:${row.edition}`;
      const bucket = grouped.get(key) ?? [];
      bucket.push(row);
      grouped.set(key, bucket);
    }

    for (const [, editionRows] of grouped) {
      const { date, edition: edNum } = editionRows[0];

      // Get or create edition
      let editionObj = data.editions.find(e => e.date === date && (e.edition ?? 1) === edNum);
      if (!editionObj) {
        editionObj = { date, edition: edNum, pages: [] };
        data = {
          ...data,
          editions: [...data.editions, editionObj].sort((a, b) => {
            const d = b.date.localeCompare(a.date);
            return d !== 0 ? d : (a.edition ?? 1) - (b.edition ?? 1);
          }),
        };
      }

      // Group rows within this edition by assignedPageId
      const byPage = new Map<number, XmlImportRow[]>();
      for (const row of editionRows) {
        const pid = row.assignedPageId;
        const bucket = byPage.get(pid) ?? [];
        bucket.push(row);
        byPage.set(pid, bucket);
      }

      for (const [pageId, pageRows] of byPage) {
        // Get or create page
        let pageObj = editionObj.pages.find(p => p.id === pageId);
        if (!pageObj) {
          // Create skeleton page
          pageObj = {
            id: pageId,
            thumbnail: '',
            fullImage: '',
            sections: [],
            imageStatus: 'pending',
          };
          editionObj.pages = [...editionObj.pages, pageObj].sort((a, b) => a.id - b.id);
          summary.skeletonPagesCreated++;
        }

        for (const row of pageRows) {
          if (row.importAction === 'skip') {
            summary.skipped++;
            continue;
          }

          if (row.importAction === 'overwrite') {
            const idx = pageObj.sections.findIndex(s => s.id === row.derivedId);
            if (idx >= 0) {
              pageObj.sections[idx] = {
                ...pageObj.sections[idx],
                title: row.title,
                content: row.content,
              };
              summary.updated++;
              continue;
            }
            // If existing section not found on this page, fall through to create
          }

          // import-as-new (or overwrite fallback)
          const newSection: NewsSection = {
            id: row.importAction === 'import-as-new'
              ? `${row.derivedId}-${Date.now()}`
              : row.derivedId,
            title: row.title,
            content: row.content,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            importSource: 'xml',
          };
          pageObj.sections = [...pageObj.sections, newSection];
          summary.created++;
        }
      }
    }

    return { data, summary };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Computes the base ID (without collision counter) for a row.
   * Used to detect intra-file duplicates before assigning the final unique ID.
   */
  private deriveBaseId(row: Pick<XmlImportRow, 'title' | 'date' | 'edition' | 'page'>): string {
    const slug = row.title
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .substring(0, 40);
    return `xml-${row.date}-e${row.edition}-p${row.page}-${slug}`;
  }

  /**
   * Derives a deterministic section ID from the row fields.
   * Collision-safe within the file via the seenIds Set.
   */
  private deriveXmlSectionId(
    row: Pick<XmlImportRow, 'title' | 'date' | 'edition' | 'page'>,
    seenIds: Set<string>,
  ): string {
    const slug = row.title
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .substring(0, 40);
    const base = `xml-${row.date}-e${row.edition}-p${row.page}-${slug}`;
    let candidate = base;
    let counter = 2;
    while (seenIds.has(candidate)) {
      candidate = `${base}-${counter++}`;
    }
    seenIds.add(candidate);
    return candidate;
  }

  /** Gets the trimmed text content of the first matching child element. */
  private getText(el: Element, tagName: string): string {
    return el.querySelector(tagName)?.textContent?.trim() ?? '';
  }

  /**
   * Sanitizes an HTML string: strips blocked tags and dangerous attributes.
   * Uses DOMParser to walk the actual DOM tree rather than regex alone.
   */
  sanitizeHtml(html: string): string {
    if (!html || !html.trim()) return '';

    // Fast path: plain text with no HTML tags — skip DOMParser entirely.
    // This covers most newspaper article content (plain text, markdown-style
    // newlines, Bengali / Arabic / Latin text without any markup).
    if (!/<[a-z!]/i.test(html)) return html.trim();

    // HTML detected — parse and sanitize the DOM tree.
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    this.sanitizeNode(parsed.body);
    return parsed.body.innerHTML;
  }

  private sanitizeNode(node: Element | ChildNode): void {
    const toRemove: ChildNode[] = [];

    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        const tag = el.tagName.toLowerCase();

        if (BLOCKED_TAGS.has(tag)) {
          toRemove.push(child);
          continue;
        }

        // Strip dangerous attributes
        const attrsToRemove: string[] = [];
        for (const attr of Array.from(el.attributes)) {
          const name = attr.name.toLowerCase();
          const value = attr.value.toLowerCase().trim();
          if (
            name.startsWith('on') ||
            (name === 'href' && value.startsWith('javascript:')) ||
            (name === 'src' && value.startsWith('javascript:')) ||
            name === 'formaction' ||
            name === 'action'
          ) {
            attrsToRemove.push(attr.name);
          }
        }
        attrsToRemove.forEach(a => el.removeAttribute(a));

        // Recurse
        this.sanitizeNode(el);
      }
    }

    toRemove.forEach(n => node.removeChild(n));
  }

  private buildResult(rows: XmlImportRow[], errors: XmlParseError[]): XmlImportResult {
    const validDates = rows.map(r => r.date).filter(Boolean).sort();
    const duplicateCount = rows.filter(r => r.duplicateStatus !== 'new').length;
    return {
      rows,
      errors,
      totalRows: rows.length,
      newCount: rows.length - duplicateCount,
      duplicateCount,
      errorCount: errors.filter(e => e.severity === 'error').length,
      dateRange: validDates.length > 0
        ? { min: validDates[0], max: validDates[validDates.length - 1] }
        : { min: '', max: '' },
    };
  }
}
