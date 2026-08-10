/**
 * End-to-end ArkTS ↔ C/C++ NAPI bridge: real HomeGraph index (not resolver-only).
 * Covers the seams unit tests missed — extract emits calls refs AND resolve links them.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { HomeGraph } from '../../../src';
import { initGrammars, loadAllGrammars } from '../../../src/extraction/grammars';
import type { Node } from '../../../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function writeProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-napi-e2e-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
}

function arktsCallable(cg: HomeGraph, name: string): Node {
  const n = cg
    .getNodesByName(name)
    .find((x) => x.language === 'arkts' && (x.kind === 'method' || x.kind === 'function'));
  expect(n, `missing arkts callable ${name}`).toBeDefined();
  return n!;
}

function expectCallsEdge(cg: HomeGraph, fromName: string, toName: string, toPathPart?: string): void {
  const from = arktsCallable(cg, fromName);
  const callees = cg.getCallees(from.id, 1);
  const hit = callees.find(
    (c) =>
      c.node.name === toName &&
      (c.node.language === 'cpp' || c.node.language === 'c') &&
      (!toPathPart || c.node.filePath.replace(/\\/g, '/').includes(toPathPart))
  );
  expect(
    hit,
    `${fromName} should call ${toName}` +
      (toPathPart ? ` in *${toPathPart}*` : '') +
      `; callees=${callees.map((c) => `${c.node.language}:${c.node.name}@${c.node.filePath}`).join(', ') || '(none)'}`
  ).toBeDefined();
}

describe('arkts-napi end-to-end (index + callers/callees)', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* windows lock */
      }
      dir = undefined;
    }
  });

  it('bridges foldeffect-style flat camelCase (mattes.draw → NapiDraw)', async () => {
    dir = writeProject({
      'ets/ScreenEffect.ets': `
import mattes from 'libeffectrender.so';

export class ScreenEffect {
  callDraw(): void {
    mattes.draw(1, 2, 3, true, false);
  }
}
`,
      'cpp/napi_init.cpp': `
#include "napi/native_api.h"
static napi_value NapiDraw(napi_env env, napi_callback_info info) { return nullptr; }
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
    {"draw", nullptr, NapiDraw, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}
`,
    });

    const cg = HomeGraph.initSync(dir);
    await cg.indexAll();
    expectCallsEdge(cg, 'callDraw', 'NapiDraw', 'napi_init.cpp');
    cg.close();
  });

  it('bridges define_class instance methods (inst?.addVerticalRuler → NapiAddVerticalRuler)', async () => {
    dir = writeProject({
      'ets/PackProxy.ets': `
import { LayoutRotatePacking } from 'libLayoutRotatePacking.so';

export class PackProxy {
  private inst: LayoutRotatePacking | null = null;

  constructor() {
    this.inst = new LayoutRotatePacking(0, 10, 10);
  }

  addRuler(): void {
    this.inst?.addVerticalRuler(3);
  }
}
`,
      'cpp/layout_rotate_packing.cpp': `
#include "napi/native_api.h"
void AddVerticalRuler(int x) { (void)x; }
static napi_value NapiAddVerticalRuler(napi_env env, napi_callback_info info) {
  AddVerticalRuler(0);
  return nullptr;
}
static napi_value NapiConstructor(napi_env env, napi_callback_info info) { return nullptr; }
static napi_value NapiInit(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"addVerticalRuler", nullptr, NapiAddVerticalRuler, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_value cons;
  napi_define_class(env, "LayoutRotatePacking", NAPI_AUTO_LENGTH, NapiConstructor, nullptr,
                    sizeof(properties) / sizeof(properties[0]), properties, &cons);
  napi_set_named_property(env, exports, "LayoutRotatePacking", cons);
  return exports;
}
`,
    });

    const cg = HomeGraph.initSync(dir);
    await cg.indexAll();
    expectCallsEdge(cg, 'addRuler', 'NapiAddVerticalRuler', 'layout_rotate_packing.cpp');
    cg.close();
  });

  it('bridges DECLARE_NAPI_FUNCTION macros', async () => {
    dir = writeProject({
      'ets/MacroCaller.ets': `
import native from 'libmacro.so';

export class MacroCaller {
  invoke(): void {
    native.foo();
  }
}
`,
      'cpp/napi_macros.cpp': `
#include "napi/native_api.h"
#ifndef DECLARE_NAPI_FUNCTION
#define DECLARE_NAPI_FUNCTION(name, func) {name, nullptr, func, nullptr, nullptr, nullptr, napi_default, nullptr}
#endif
static napi_value NapiFoo(napi_env env, napi_callback_info info) { return nullptr; }
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    DECLARE_NAPI_FUNCTION("foo", NapiFoo),
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}
`,
    });

    const cg = HomeGraph.initSync(dir);
    await cg.indexAll();
    expectCallsEdge(cg, 'invoke', 'NapiFoo', 'napi_macros.cpp');
    cg.close();
  });

  it('bridges napi_create_function mounts', async () => {
    dir = writeProject({
      'ets/CreateCaller.ets': `
import native from 'libcreate.so';

export class CreateCaller {
  go(): void {
    native.run();
  }
}
`,
      'cpp/napi_create.cpp': `
#include "napi/native_api.h"
static napi_value NapiRun(napi_env env, napi_callback_info info) { return nullptr; }
static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "run", NAPI_AUTO_LENGTH, NapiRun, nullptr, &fn);
  napi_set_named_property(env, exports, "run", fn);
  return exports;
}
`,
    });

    const cg = HomeGraph.initSync(dir);
    await cg.indexAll();
    expectCallsEdge(cg, 'go', 'NapiRun', 'napi_create.cpp');
    cg.close();
  });

  it('bridges napi_define_sendable_class exports', async () => {
    dir = writeProject({
      'ets/SendableCaller.ets': `
import { Pingable } from 'libsendable.so';

export class SendableCaller {
  pingOnce(): void {
    const p = new Pingable();
    p.ping();
  }
}
`,
      'cpp/napi_sendable.cpp': `
#include "napi/native_api.h"
static napi_value NapiPing(napi_env env, napi_callback_info info) { return nullptr; }
static napi_value NapiCtor(napi_env env, napi_callback_info info) { return nullptr; }
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    {"ping", nullptr, NapiPing, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_value cons;
  napi_define_sendable_class(env, "Pingable", NAPI_AUTO_LENGTH, NapiCtor, nullptr,
                             sizeof(props) / sizeof(props[0]), props, &cons);
  napi_set_named_property(env, exports, "Pingable", cons);
  return exports;
}
`,
    });

    const cg = HomeGraph.initSync(dir);
    await cg.indexAll();
    expectCallsEdge(cg, 'pingOnce', 'NapiPing', 'napi_sendable.cpp');
    cg.close();
  });

  it('bridges photos-style Class_method on lib*.so', async () => {
    dir = writeProject({
      'ets/Asset.ets': `
import sdk from 'libImageEditor.so';

export class Asset {
  setCropRect(left: number, top: number): boolean {
    return sdk.Asset_setCropRect(left, top);
  }
}
`,
      'cpp/napi_adapter.cpp': `
#include "napi/native_api.h"
static napi_value Asset_setCropRect(napi_env env, napi_callback_info info) { return nullptr; }
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
    {"Asset_setCropRect", nullptr, Asset_setCropRect, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}
`,
    });

    const cg = HomeGraph.initSync(dir);
    await cg.indexAll();
    expectCallsEdge(cg, 'setCropRect', 'Asset_setCropRect', 'napi_adapter.cpp');
    cg.close();
  });
});
