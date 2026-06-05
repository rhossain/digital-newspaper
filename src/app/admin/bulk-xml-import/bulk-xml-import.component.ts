import {
  Component,
  EventEmitter,
  HostListener,
  Input,
  OnInit,
  Output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import {
  NewspaperData,
  NewspaperEdition,
  NewspaperPage,
  XmlImportResult,
  XmlImportRow,
  XmlImportSummary,
  XmlParseError,
} from '../../services/newspaper-data.service';
import { XmlImportService } from '../../services/xml-import.service';
import { NewspaperDataService } from '../../services/newspaper-data.service';

// ─── Local helpers ───────────────────────────────────────────────────────────

interface PageGroup {
  date: string;
  edition: number;
  pageId: number;
  rows: XmlImportRow[];
}

interface DateEditionGroup {
  date: string;
  edition: number;
  groups: PageGroup[];
  collapsed: boolean;
}

type FilterMode = 'all' | 'new' | 'duplicates' | 'errors';

@Component({
  selector: 'app-bulk-xml-import',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './bulk-xml-import.component.html',
  styleUrls: ['./bulk-xml-import.component.css'],
})
export class BulkXmlImportComponent implements OnInit {
  /** Emitted when the user closes the modal without completing an import. */
  @Output() closed = new EventEmitter<void>();
  /** Emitted after a successful import so the parent can refresh its view. */
  @Output() importCompleted = new EventEmitter<{ firstDate: string }>();

  // ─── Wizard state ─────────────────────────────────────────────────────────
  currentStep: 1 | 2 | 3 | 4 = 1;
  isImporting = false;
  importSummary: XmlImportSummary | null = null;
  importError: string | null = null;
  importProgressStage: 'idle' | 'parsing' | 'merging' | 'saving' | 'done' = 'idle';

  // ─── Step 1 ───────────────────────────────────────────────────────────────
  xmlFile: File | null = null;
  parseResult: XmlImportResult | null = null;
  isParsingFile = false;
  isDragging = false;

  // ─── Step 2 ───────────────────────────────────────────────────────────────
  importRows: XmlImportRow[] = [];
  dateEditionGroups: DateEditionGroup[] = [];
  filterMode: FilterMode = 'all';
  selectedRowIds = new Set<string>();
  availableExistingPages: NewspaperPage[] = [];
  /** Date/edition selector in the right panel */
  rightPanelDate = '';
  rightPanelEdition = 1;

  // ─── Step 3 ───────────────────────────────────────────────────────────────
  applyActionToAll: 'skip' | 'overwrite' | 'import-as-new' | '' = '';

  // ─── Step 4 ───────────────────────────────────────────────────────────────
  autoBackup = true;
  skeletonPages: { date: string; edition: number; pageId: number }[] = [];
  firstImportedDate = '';

  constructor(
    private xmlImportService: XmlImportService,
    private dataService: NewspaperDataService,
  ) {}

  ngOnInit(): void {}

  // ─── Close / backdrop ────────────────────────────────────────────────────

  close(): void {
    this.closed.emit();
  }

  onBackdropClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('bxi-backdrop')) {
      this.close();
    }
  }

  @HostListener('keydown.escape')
  onEscape(): void {
    this.close();
  }

  // ─── Step 1 — Upload & Parse ─────────────────────────────────────────────

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDragging = true;
  }

  onDragLeave(): void {
    this.isDragging = false;
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragging = false;
    const file = event.dataTransfer?.files?.[0];
    if (file) this.processFile(file);
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) this.processFile(file);
    input.value = ''; // reset so the same file can be re-selected
  }

  triggerFileInput(): void {
    document.getElementById('bxi-file-input')?.click();
  }

  downloadTemplate(): void {
    // Point to the pre-built template asset
    const link = document.createElement('a');
    link.href = 'assets/import-template.xlsx';
    link.download = 'import-template.xlsx';
    link.click();
  }

  get acceptedExtensions(): string {
    return '.xlsx,.xls,.csv,.xml';
  }

  private isExcelFile(file: File): boolean {
    const name = file.name.toLowerCase();
    return name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv');
  }

  clearFile(): void {
    this.xmlFile = null;
    this.parseResult = null;
    this.importRows = [];
  }

  private processFile(file: File): void {
    const name = file.name.toLowerCase();
    const isXml    = name.endsWith('.xml');
    const isExcel  = name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv');

    if (!isXml && !isExcel) {
      alert('Please select an Excel (.xlsx, .xls, .csv) or XML (.xml) file.');
      return;
    }

    this.xmlFile = file;
    this.isParsingFile = true;

    // Use setTimeout so the spinner renders before the synchronous parse blocks
    setTimeout(() => {
      const reader = new FileReader();

      reader.onload = (e) => {
        try {
          let result;

          if (isExcel) {
            const buffer = e.target?.result as ArrayBuffer;
            result = this.xmlImportService.parseExcel(buffer);
          } else {
            const content = e.target?.result as string;
            result = this.xmlImportService.parseXml(content);
          }

          // Cross-check against existing data
          const currentData = this.dataService.getData();
          const rowsWithDuplicates = this.xmlImportService.detectDuplicates(result.rows, currentData);
          result.rows = rowsWithDuplicates;

          // Recompute counts after duplicate detection
          const dupCount = rowsWithDuplicates.filter(r => r.duplicateStatus !== 'new').length;
          result.duplicateCount = dupCount;
          result.newCount = rowsWithDuplicates.length - dupCount;

          this.parseResult = result;
          this.importRows = [...rowsWithDuplicates];
        } catch (err: unknown) {
          this.parseResult = {
            rows: [], errors: [{
              rowIndex: -1, field: 'file',
              message: `Unexpected error while parsing: ${err instanceof Error ? err.message : String(err)}`,
              severity: 'error',
            }],
            totalRows: 0, newCount: 0, duplicateCount: 0, errorCount: 1,
            dateRange: { min: '', max: '' },
          };
        } finally {
          this.isParsingFile = false;
        }
      };

      if (isExcel) {
        reader.readAsArrayBuffer(file);
      } else {
        reader.readAsText(file);
      }
    }, 50);
  }

  get hasFatalErrors(): boolean {
    return (this.parseResult?.errors ?? []).some(e => e.severity === 'error');
  }

  get fatalErrors(): XmlParseError[] {
    return (this.parseResult?.errors ?? []).filter(e => e.severity === 'error');
  }

  get warnings(): XmlParseError[] {
    return (this.parseResult?.errors ?? []).filter(e => e.severity === 'warning');
  }

  // ─── Navigation ──────────────────────────────────────────────────────────

  goToStep2(): void {
    if (!this.parseResult || this.hasFatalErrors) return;
    // Select all non-intra-file-duplicate rows by default
    this.importRows.forEach(r => {
      if (r.importAction !== 'skip') this.selectedRowIds.add(r.derivedId);
    });
    this.selectedRowIds = new Set(this.selectedRowIds);
    this.currentStep = 2;
  }

  goToStep3(): void {
    // Apply selection state to importAction before moving on
    this.importRows.forEach(r => {
      if (!this.selectedRowIds.has(r.derivedId)) {
        r.importAction = 'skip';
      } else if (r.importAction === 'skip' && r.duplicateStatus === 'new') {
        r.importAction = 'import-as-new';
      }
    });
    const hasDupes = this.importRows.some(
      r => r.duplicateStatus !== 'new' && this.selectedRowIds.has(r.derivedId)
    );
    this.currentStep = hasDupes ? 3 : 4;
    if (this.currentStep === 4) this.buildStep4Summary();
  }

  goToStep4(): void {
    this.buildStep4Summary();
    this.currentStep = 4;
  }

  goBack(): void {
    if (this.currentStep === 2) this.currentStep = 1;
    else if (this.currentStep === 3) this.currentStep = 2;
    else if (this.currentStep === 4) {
      const hasDupes = this.importRows.some(r => r.duplicateStatus !== 'new' && this.selectedRowIds.has(r.derivedId));
      this.currentStep = hasDupes ? 3 : 2;
    }
  }

  // ─── Step 2 helpers — simple flat table ──────────────────────────────────

  get selectedCount(): number {
    return this.selectedRowIds.size;
  }

  get allSelected(): boolean {
    return this.importRows.length > 0 && this.importRows.every(r => this.selectedRowIds.has(r.derivedId));
  }

  toggleSelectAll(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    if (checked) {
      this.importRows.forEach(r => this.selectedRowIds.add(r.derivedId));
    } else {
      this.selectedRowIds.clear();
    }
    this.selectedRowIds = new Set(this.selectedRowIds);
  }

  toggleRowSelection(id: string): void {
    if (this.selectedRowIds.has(id)) {
      this.selectedRowIds.delete(id);
    } else {
      this.selectedRowIds.add(id);
    }
    this.selectedRowIds = new Set(this.selectedRowIds);
  }

  isSelected(id: string): boolean {
    return this.selectedRowIds.has(id);
  }

  selectAll(): void {
    this.importRows.forEach(r => this.selectedRowIds.add(r.derivedId));
    this.selectedRowIds = new Set(this.selectedRowIds);
  }

  deselectAll(): void {
    this.selectedRowIds.clear();
    this.selectedRowIds = new Set(this.selectedRowIds);
  }

  toggleGroupCollapse(group: DateEditionGroup): void {
    group.collapsed = !group.collapsed;
  }

  assignSelectedToPage(pageId: number): void {
    for (const id of this.selectedRowIds) {
      const row = this.importRows.find(r => r.derivedId === id);
      if (row) {
        row.assignedPageId = pageId;
      }
    }
    this.buildDateEditionGroups();
  }

  /**
   * Rebuild `dateEditionGroups` from the current `importRows`.
   *
   * Groups rows first by (date, edition), then by assignedPageId within each
   * date-edition group.  Existing collapsed state is preserved for groups
   * that still exist after the rebuild.
   */
  buildDateEditionGroups(): void {
    // Preserve which (date:edition) keys were collapsed so a re-build doesn't
    // reset the UI state.
    const collapsedKeys = new Set(
      this.dateEditionGroups
        .filter(g => g.collapsed)
        .map(g => `${g.date}:${g.edition}`)
    );

    // Group rows by date+edition key
    const deMap = new Map<string, { date: string; edition: number; rows: XmlImportRow[] }>();
    for (const row of this.importRows) {
      const key = `${row.date}:${row.edition}`;
      if (!deMap.has(key)) {
        deMap.set(key, { date: row.date, edition: row.edition, rows: [] });
      }
      deMap.get(key)!.rows.push(row);
    }

    // For each date-edition, group rows further by assignedPageId
    const groups: DateEditionGroup[] = [];
    for (const [deKey, de] of deMap) {
      const pageMap = new Map<number, XmlImportRow[]>();
      for (const row of de.rows) {
        if (!pageMap.has(row.assignedPageId)) {
          pageMap.set(row.assignedPageId, []);
        }
        pageMap.get(row.assignedPageId)!.push(row);
      }

      const pageGroups: PageGroup[] = Array.from(pageMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([pageId, rows]) => ({ date: de.date, edition: de.edition, pageId, rows }));

      groups.push({
        date: de.date,
        edition: de.edition,
        groups: pageGroups,
        collapsed: collapsedKeys.has(deKey),
      });
    }

    // Sort: newest date first, then edition ascending
    groups.sort((a, b) => {
      const d = b.date.localeCompare(a.date);
      return d !== 0 ? d : a.edition - b.edition;
    });

    this.dateEditionGroups = groups;
  }

  queuedCountForPage(pageId: number): number {
    return this.importRows.filter(r => r.assignedPageId === pageId).length;
  }

  setRowAction(row: XmlImportRow, action: XmlImportRow['importAction']): void {
    row.importAction = action;
  }

  setRowTitle(row: XmlImportRow, title: string): void {
    row.title = title;
  }

  contentPreview(row: XmlImportRow): string {
    const stripped = row.content.replace(/<[^>]*>/g, '');
    return stripped.substring(0, 80) + (stripped.length > 80 ? '…' : '');
  }

  rightPanelPages(): NewspaperPage[] {
    // Merge existing pages with skeleton pages that XML rows target
    const existing = [...this.availableExistingPages];
    const existingIds = new Set(existing.map(p => p.id));

    for (const row of this.importRows) {
      if (row.date === this.rightPanelDate && row.edition === this.rightPanelEdition) {
        if (!existingIds.has(row.assignedPageId)) {
          existing.push({ id: row.assignedPageId, thumbnail: '', fullImage: '', sections: [], imageStatus: 'pending' });
          existingIds.add(row.assignedPageId);
        }
      }
    }

    return existing.sort((a, b) => a.id - b.id);
  }

  addSkeletonPageInPanel(): void {
    const pages = this.rightPanelPages();
    const maxId = pages.reduce((m, p) => Math.max(m, p.id), 0);
    const newId = maxId + 1;
    // Assign all selected rows to this new page
    if (this.selectedRowIds.size > 0) {
      this.assignSelectedToPage(newId);
    }
  }

  get unassignedRows(): XmlImportRow[] {
    const existingPageIds = new Set(this.availableExistingPages.map(p => p.id));
    return this.importRows.filter(r => !existingPageIds.has(r.assignedPageId));
  }

  // ─── Step 3 helpers ──────────────────────────────────────────────────────

  get duplicateRows(): XmlImportRow[] {
    return this.importRows.filter(r => r.duplicateStatus !== 'new');
  }

  applyActionToAllDuplicates(): void {
    if (!this.applyActionToAll) return;
    for (const row of this.duplicateRows) {
      row.importAction = this.applyActionToAll;
    }
    // Trigger change detection
    this.importRows = [...this.importRows];
  }

  get step3SkipCount(): number {
    return this.duplicateRows.filter(r => r.importAction === 'skip').length;
  }

  get step3OverwriteCount(): number {
    return this.duplicateRows.filter(r => r.importAction === 'overwrite').length;
  }

  get step3ImportAsNewCount(): number {
    return this.duplicateRows.filter(r => r.importAction === 'import-as-new').length;
  }

  // ─── Step 4 helpers ──────────────────────────────────────────────────────

  private buildStep4Summary(): void {
    const currentData = this.dataService.getData();
    const { summary: mockSummary, data: previewData } = this.xmlImportService.applyXmlImport(
      this.importRows,
      currentData,
    );
    this.importSummary = mockSummary;

    // Collect skeleton pages
    this.skeletonPages = [];
    for (const ed of previewData.editions) {
      for (const pg of ed.pages) {
        if (pg.imageStatus === 'pending') {
          this.skeletonPages.push({ date: ed.date, edition: ed.edition ?? 1, pageId: pg.id });
        }
      }
    }
  }

  get impactEditionsCount(): number {
    const keys = new Set(this.importRows.map(r => `${r.date}:${r.edition}`));
    return keys.size;
  }

  get impactPagesCount(): number {
    const keys = new Set(this.importRows.map(r => `${r.date}:${r.edition}:${r.assignedPageId}`));
    return keys.size;
  }

  async doImport(): Promise<void> {
    if (this.isImporting) return;
    this.isImporting = true;
    this.importError = null;

    try {
      this.importProgressStage = 'parsing';
      const currentData = this.dataService.getData();

      this.importProgressStage = 'merging';
      const { data: newData, summary } = this.xmlImportService.applyXmlImport(
        this.importRows,
        currentData,
      );
      this.importSummary = summary;

      // Auto-backup before saving
      if (this.autoBackup) {
        this.dataService.downloadExport({ exportType: 'full', exportScope: 'full' });
      }

      this.importProgressStage = 'saving';
      await new Promise<void>((resolve, reject) => {
        this.dataService.saveData(newData).subscribe({
          next: () => resolve(),
          error: (err: unknown) => reject(err),
        });
      });

      this.importProgressStage = 'done';

      // Determine first imported date for navigation
      const dates = [...new Set(this.importRows.map(r => r.date))].sort();
      this.firstImportedDate = dates[0] ?? '';
    } catch (err: unknown) {
      this.importError = err instanceof Error ? err.message : String(err);
      this.importProgressStage = 'idle';
    } finally {
      this.isImporting = false;
    }
  }

  goToContent(): void {
    this.importCompleted.emit({ firstDate: this.firstImportedDate });
    this.close();
  }

  /** Navigate to the page editor for the first skeleton page so the user can upload an image. */
  goToSetPageImages(): void {
    this.importCompleted.emit({ firstDate: this.skeletonPages[0]?.date ?? this.firstImportedDate });
    this.close();
  }

  resetWizard(): void {
    this.currentStep = 1;
    this.xmlFile = null;
    this.parseResult = null;
    this.isParsingFile = false;
    this.importRows = [];
    this.dateEditionGroups = [];
    this.selectedRowIds = new Set();
    this.importSummary = null;
    this.importError = null;
    this.importProgressStage = 'idle';
    this.skeletonPages = [];
    this.firstImportedDate = '';
    this.applyActionToAll = '';
    this.filterMode = 'all';
  }

  // ─── Template helpers ────────────────────────────────────────────────────

  statusBadgeClass(row: XmlImportRow): string {
    if (row.importAction === 'skip') return 'bxi-badge--grey';
    if (row.duplicateStatus === 'duplicate-key') return 'bxi-badge--amber';
    if (row.duplicateStatus === 'duplicate-exact') return 'bxi-badge--grey';
    return 'bxi-badge--green';
  }

  statusBadgeLabel(row: XmlImportRow): string {
    if (row.duplicateStatus === 'duplicate-exact' && row.importAction === 'skip') return 'Skip (exact)';
    if (row.duplicateStatus === 'duplicate-key' && row.importAction === 'overwrite') return 'Overwrite';
    if (row.duplicateStatus === 'duplicate-key' && row.importAction === 'skip') return 'Skip';
    if (row.importAction === 'import-as-new') return 'New';
    return row.importAction;
  }

  progressLabel(): string {
    switch (this.importProgressStage) {
      case 'parsing': return 'Preparing posts…';
      case 'merging': return 'Merging into newspaper data…';
      case 'saving':  return 'Saving to WordPress — this may take 10–30 seconds…';
      case 'done':    return 'Done!';
      default:        return '';
    }
  }

  trackByDerivedId(_: number, row: XmlImportRow): string {
    return row.derivedId;
  }

  trackByKey(_: number, group: DateEditionGroup): string {
    return `${group.date}:${group.edition}`;
  }

  trackByPageId(_: number, pg: PageGroup): number {
    return pg.pageId;
  }
}
