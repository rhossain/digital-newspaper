import {
  Component,
  OnDestroy,
  OnInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { LoaderService, LoaderState } from '../../services/loader.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-loader',
  standalone: true,
  imports: [],   // template uses @if control flow — no directive imports needed
  templateUrl: './loader.component.html',
  styleUrls: ['./loader.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoaderComponent implements OnInit, OnDestroy {
  state: LoaderState = { isLoading: false, message: '' };
  showSlowWarning = false;

  private sub?: Subscription;
  private slowTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private loaderService: LoaderService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.sub = this.loaderService.state$.subscribe(state => {
      const wasLoading = this.state.isLoading;
      this.state = state;

      if (state.isLoading && !wasLoading) {
        // Start the slow-response warning after 30 s
        this.slowTimer = setTimeout(() => {
          this.showSlowWarning = true;
          this.cdr.markForCheck();
        }, 30_000);
      }

      if (!state.isLoading) {
        clearTimeout(this.slowTimer);
        this.showSlowWarning = false;
      }

      this.cdr.markForCheck();
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    clearTimeout(this.slowTimer);
  }
}
