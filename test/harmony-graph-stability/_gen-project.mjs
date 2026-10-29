import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'project');

function w(rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content.trimStart());
}

const mods = ['mod_a', 'mod_b', 'mod_c', 'mod_d', 'mod_e'];
const deps = {
  mod_a: [],
  mod_b: ['mod_a'],
  mod_c: ['mod_b'],
  mod_d: ['mod_c'],
  mod_e: ['mod_d'],
};

w(
  'build-profile.json5',
  `
{
  modules: [
    { name: 'mod_a', srcPath: './mod_a' },
    { name: 'mod_b', srcPath: './mod_b' },
    { name: 'mod_c', srcPath: './mod_c' },
    { name: 'mod_d', srcPath: './mod_d' },
    { name: 'mod_e', srcPath: './mod_e' }
  ]
}
`
);

w(
  'oh-package.json5',
  `
{
  name: 'harmony-graph-stability',
  version: '1.0.0'
}
`
);

for (const m of mods) {
  const depList = deps[m];
  const letter = m.slice(-1).toUpperCase();
  const depJson =
    depList.length === 0
      ? ''
      : `,\n  dependencies: {\n${depList
          .map((d) => `    "@ohos/${d}": "file:../${d}"`)
          .join(',\n')}\n  }`;

  w(
    `${m}/oh-package.json5`,
    `
{
  name: '@ohos/${m}',
  version: '1.0.0'${depJson}
}
`
  );

  w(
    `${m}/src/main/module.json5`,
    `
{
  module: {
    name: '${m}',
    type: '${m === 'mod_a' ? 'entry' : 'feature'}',
    deviceTypes: ['phone']
  }
}
`
  );

  w(
    `${m}/src/main/ets/Page${letter}.ets`,
    `
import { Child${letter} } from './Child${letter}';
import { runLib${letter} } from './Lib${letter}';
import { helper${letter} } from './Util${letter}';

@Entry
@Component
struct Page${letter} {
  @State count: number = 0;

  aboutToAppear(): void {
    runLib${letter}(() => { this.count += 1; });
  }

  build() {
    Column() {
      Text('Page${letter} ' + this.count)
      Button('inc')
        .onClick(() => {
          this.count = helper${letter}(this.count);
        })
      Child${letter}({ label: 'c${letter}' })
    }
  }
}
`
  );

  w(
    `${m}/src/main/ets/Child${letter}.ets`,
    `
@Component
struct Child${letter} {
  @Prop label: string = '';

  build() {
    Row() {
      Text(this.label)
        .onClick(() => {
          console.info('child-${letter}');
        })
    }
  }
}

export { Child${letter} };
`
  );

  w(
    `${m}/src/main/ets/Lib${letter}.ets`,
    `
import { Base${letter} } from './Base${letter}';

export class Worker${letter} extends Base${letter} {
  run(cb: () => void): void {
    const items = [1, 2, 3];
    items.forEach((n: number) => {
      if (n > 0) {
        this.touch(n, () => { cb(); });
      }
    });
  }

  touch(n: number, done: () => void): void {
    done();
  }
}

export function runLib${letter}(cb: () => void): void {
  const w = new Worker${letter}();
  w.run(() => { cb(); });
}
`
  );

  w(
    `${m}/src/main/ets/Base${letter}.ets`,
    `
export interface IFace${letter} {
  tag(): string;
}

export class Base${letter} implements IFace${letter} {
  tag(): string {
    return '${letter}';
  }
}
`
  );

  if (depList.length) {
    const d = depList[0];
    const dl = d.slice(-1).toUpperCase();
    // From mod_X/src/main/ets → sibling module: ../../../../mod_y/src/main/ets/UtilY
    w(
      `${m}/src/main/ets/Util${letter}.ets`,
      `
import { helper${dl} } from '../../../../${d}/src/main/ets/Util${dl}';

export function helper${letter}(n: number): number {
  const wrap = (x: number): number => x + 1;
  return wrap(helper${dl}(n));
}

export function mapAll${letter}(xs: number[]): number[] {
  return xs.map((v: number) => helper${letter}(v));
}
`
    );
  } else {
    w(
      `${m}/src/main/ets/Util${letter}.ets`,
      `
export function helper${letter}(n: number): number {
  const wrap = (x: number): number => x + 1;
  return wrap(n);
}

export function mapAll${letter}(xs: number[]): number[] {
  return xs.map((v: number) => helper${letter}(v));
}
`
    );
  }
}

console.log('wrote', root);
