import { ChildC } from './ChildC';
import { runLibC } from './LibC';
import { helperC } from './UtilC';

@Entry
@Component
struct PageC {
  @State count: number = 0;

  aboutToAppear(): void {
    runLibC(() => { this.count += 1; });
  }

  build() {
    Column() {
      Text('PageC ' + this.count)
      Button('inc')
        .onClick(() => {
          this.count = helperC(this.count);
        })
      ChildC({ label: 'cC' })
    }
  }
}
