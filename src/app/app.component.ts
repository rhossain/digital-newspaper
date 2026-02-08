import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ToasterComponent } from './toaster/toaster.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ToasterComponent],
  template: `
    <router-outlet></router-outlet>
    <app-toaster></app-toaster>
  `,
  styles: []
})
export class AppComponent {
  title = 'digital-newspaper';
}
