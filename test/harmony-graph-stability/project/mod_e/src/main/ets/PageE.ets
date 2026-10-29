import { ChildE } from './ChildE';
import { runLibE } from './LibE';
import { helperE } from './UtilE';

@Entry
@Component
struct PageE {
  @State count: number = 0;

  aboutToAppear(): void {
    runLibE(() => { this.count += 1; });
  }

  build() {
    Column() {
      Text('PageE ' + this.count)
      Button('inc')
        .onClick(() => {
          this.count = helperE(this.count);
        })
      ChildE({ label: 'cE' })
    }
  }
}
