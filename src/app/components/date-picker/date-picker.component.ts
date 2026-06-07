import {
  Component, Input, Output, EventEmitter,
  OnChanges, SimpleChanges, HostListener
} from '@angular/core';

import { TranslationService } from '../../i18n/translation.service';
import { LocaleDatePipe } from '../../i18n/locale-date.pipe';

interface CalendarDay {
  dateStr: string;
  day: number;
  inMonth: boolean;
  isSelected: boolean;
  isToday: boolean;
  isDisabled: boolean;
  isAvailable: boolean;
}

@Component({
  selector: 'app-date-picker',
  standalone: true,
  imports: [LocaleDatePipe],
  templateUrl: './date-picker.component.html',
  styleUrls: ['./date-picker.component.css']
})
export class DatePickerComponent implements OnChanges {
  @Input() value: string = '';
  @Input() max: string = '';
  @Input() availableDates: string[] = [];
  @Output() valueChange = new EventEmitter<string>();

  isOpen = false;
  viewYear = 0;
  viewMonth = 0; // 0-based
  weeks: CalendarDay[][] = [];

  constructor(public ts: TranslationService) {}

  ngOnChanges(changes: SimpleChanges) {
    if (!this.viewYear) this.initView();
    this.buildCalendar();
  }

  private initView() {
    const base = this.value ? new Date(this.value + 'T00:00:00') : new Date();
    this.viewYear = base.getFullYear();
    this.viewMonth = base.getMonth();
  }

  toggle(event: MouseEvent) {
    event.stopPropagation();
    this.isOpen = !this.isOpen;
    if (this.isOpen) {
      this.initView();
      this.buildCalendar();
    }
  }

  stopProp(event: MouseEvent) {
    event.stopPropagation();
  }

  /** Close popup when clicking anywhere outside this component. */
  @HostListener('document:click')
  onDocumentClick() {
    this.isOpen = false;
  }

  prevMonth() {
    if (this.viewMonth === 0) { this.viewMonth = 11; this.viewYear--; }
    else { this.viewMonth--; }
    this.buildCalendar();
  }

  nextMonth() {
    if (this.isNextMonthDisabled()) return;
    if (this.viewMonth === 11) { this.viewMonth = 0; this.viewYear++; }
    else { this.viewMonth++; }
    this.buildCalendar();
  }

  selectDay(day: CalendarDay) {
    if (day.isDisabled || !day.inMonth) return;
    this.valueChange.emit(day.dateStr);
    this.isOpen = false;
  }

  get monthLabel(): string {
    return this.ts.dates.months[this.viewMonth] + ' ' + this.ts.toLocaleDigits(this.viewYear);
  }

  get weekDayHeaders(): string[] {
    return this.ts.dates.shortDays;
  }

  isNextMonthDisabled(): boolean {
    const maxDate = this.max ? new Date(this.max + 'T00:00:00') : new Date();
    return (
      this.viewYear > maxDate.getFullYear() ||
      (this.viewYear === maxDate.getFullYear() && this.viewMonth >= maxDate.getMonth())
    );
  }

  private buildCalendar() {
    if (!this.viewYear) return;

    const todayStr = new Date().toISOString().split('T')[0];
    const maxStr = this.max || todayStr;
    const availableSet = new Set(this.availableDates);

    // Weekday index of the 1st of the view month (0 = Sunday)
    const startWeekday = new Date(this.viewYear, this.viewMonth, 1).getDay();
    const daysInMonth = new Date(this.viewYear, this.viewMonth + 1, 0).getDate();
    const prevMonthDays = new Date(this.viewYear, this.viewMonth, 0).getDate();

    const cells: CalendarDay[] = [];

    // ── Leading cells from previous month (grayed, non-selectable) ──
    for (let i = startWeekday - 1; i >= 0; i--) {
      const d = prevMonthDays - i;
      const m = this.viewMonth === 0 ? 11 : this.viewMonth - 1;
      const y = this.viewMonth === 0 ? this.viewYear - 1 : this.viewYear;
      const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push({ dateStr, day: d, inMonth: false, isSelected: false, isToday: false, isDisabled: true, isAvailable: false });
    }

    // ── Current month days ──
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${this.viewYear}-${String(this.viewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push({
        dateStr, day: d, inMonth: true,
        isSelected: dateStr === this.value,
        isToday: dateStr === todayStr,
        isDisabled: dateStr > maxStr,
        isAvailable: availableSet.has(dateStr)
      });
    }

    // ── Trailing cells from next month to fill a 6×7 grid ──
    let trailing = 1;
    while (cells.length < 42) {
      const m = this.viewMonth === 11 ? 0 : this.viewMonth + 1;
      const y = this.viewMonth === 11 ? this.viewYear + 1 : this.viewYear;
      const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(trailing).padStart(2, '0')}`;
      cells.push({ dateStr, day: trailing++, inMonth: false, isSelected: false, isToday: false, isDisabled: true, isAvailable: false });
    }

    // Group into 6 weeks of 7
    const weeks: CalendarDay[][] = [];
    for (let i = 0; i < 42; i += 7) {
      weeks.push(cells.slice(i, i + 7));
    }
    this.weeks = weeks;
  }
}
