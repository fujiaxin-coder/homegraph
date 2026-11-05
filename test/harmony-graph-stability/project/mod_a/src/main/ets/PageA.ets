import { ChildA } from './ChildA';
import { runLibA } from './LibA';
import { helperA } from './UtilA';

@Entry
@Component
struct PageA {
  @State count: number = 0;

  aboutToAppear(): void {
    runLibA(() => { this.count += 1; });
  }

  /** Mutates @State — HG arkui-state synthesizes bumpCount → build. */
  bumpCount(): void {
    this.count += 1;
  }

  build() {
    Column() {
      Text('PageA ' + this.count)
      Button('inc')
        .onClick(() => {
          this.count = helperA(this.count);
        })
      ChildA({ label: 'cA' })
    }
  }
}
