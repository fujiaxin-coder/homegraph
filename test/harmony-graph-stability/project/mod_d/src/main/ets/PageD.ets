import { ChildD } from './ChildD';
import { runLibD } from './LibD';
import { helperD } from './UtilD';

@Entry
@Component
struct PageD {
  @State count: number = 0;

  aboutToAppear(): void {
    runLibD(() => { this.count += 1; });
  }

  build() {
    Column() {
      Text('PageD ' + this.count)
      Button('inc')
        .onClick(() => {
          this.count = helperD(this.count);
        })
      ChildD({ label: 'cD' })
    }
  }
}
