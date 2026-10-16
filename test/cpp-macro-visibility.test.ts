/**
 * Spec 0054 — C/C++ header language and bounded macro-include walk.
 */
import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../src/extraction/grammars';
import { isVisibleCppMacro } from '../src/resolution/cpp-macro-visibility';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';

type Guard = 'value' | 'bare' | 'unknown-flag';

function layeredHeaders(depth: number, guard: Guard): Record<string, string> {
  const files: Record<string, string> = {};
  for (let d = 0; d < depth; d++) {
    for (const side of ['a', 'b']) {
      const g = `H_${d}_${side}`;
      const open =
        guard === 'value' ? `#ifndef ${g}\n#define ${g} 1\n` :
        guard === 'bare' ? `#ifndef ${g}\n#define ${g}\n` :
        `#ifdef USE_${d}\n`;
      const next = d + 1 < depth ? `#include "h${d + 1}_a.h"\n#include "h${d + 1}_b.h"\n` : '';
      files[`h${d}_${side}.h`] = `${open}${next}#define M_${d}_${side}(x) (x)\nint f_${d}_${side}(int);\n#endif\n`;
    }
  }
  return files;
}

function contextOver(files: Record<string, string>): ResolutionContext {
  return {
    getNodesByName: () => [
      { kind: 'constant', signature: '#define TRACE(v) (v)' },
      { kind: 'function' },
    ],
    readFile: (f: string) => files[f] ?? null,
    fileExists: (f: string) => f in files,
    getAllFiles: () => Object.keys(files),
    getProjectRoot: () => '',
  } as unknown as ResolutionContext;
}

const call = (name: string, line: number): UnresolvedRef =>
  ({ language: 'cpp', referenceKind: 'calls', referenceName: name, filePath: 'unit.cpp', line } as UnresolvedRef);

describe('Spec 0054 C/C++ visibility', () => {
  it('treats a header whose only C++ signal is struct inheritance as C++', () => {
    const header = 'struct Derived : Base {\n  int n;\n};\n';
    expect(detectLanguage('native/types.h', header)).toBe('cpp');
    expect(detectLanguage('native/plain.h', 'struct Point { int x; int y; };\n')).toBe('c');
  });

  it.each(['value', 'bare', 'unknown-flag'] as const)(
    'walks a 40-layer include graph without exploding (%s guards)',
    (guard) => {
      const files = {
        ...layeredHeaders(40, guard),
        'trace.h': '#define TRACE(v) ((void)(v))\n',
        'unit.cpp': '#include "h0_a.h"\n#include "h0_b.h"\n#include "trace.h"\nvoid unit() { TRACE(1); }\n',
      };
      const started = performance.now();
      expect(isVisibleCppMacro(call('TRACE', 4), contextOver(files))).toBe(true);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(isVisibleCppMacro(call('TRACE', 2), contextOver(files))).toBe(false);
    },
  );
});
