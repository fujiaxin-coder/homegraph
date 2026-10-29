import { ChildB } from './ChildB';
import { runLibB } from './LibB';
import { helperB } from './UtilB';

@Entry
@Component
struct PageB {
  @State count: number = 0;

  aboutToAppear(): void {
    runLibB(() => { this.count += 1; });
  }

  build() {
    Column() {
      Text('PageB ' + this.count)
      Button('inc')
        .onClick(() => {
          this.count = helperB(this.count);
        })
      ChildB({ label: 'cB' })
    }
  }
}
