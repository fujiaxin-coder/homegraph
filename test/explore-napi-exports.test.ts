/**
 * NAPI export survey must list napi_property_descriptor API names
 * (draw/finishDraw/…), not only Export/Init shells (D72).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import HomeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('homegraph_explore — NAPI export survey', () => {
  let testDir: string;
  let cg: HomeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-napi-'));
    const cpp = path.join(testDir, 'feature', 'foldeffect', 'src', 'main', 'cpp');
    fs.mkdirSync(cpp, { recursive: true });
    fs.writeFileSync(
      path.join(cpp, 'napi_init.cpp'),
      `#include "napi/native_api.h"
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
    {"draw", nullptr, PluginManager::NapiDraw, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"finishDraw", nullptr, PluginManager::NapiFinishDraw, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setDirection", nullptr, PluginManager::NapiSetDirection, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  PluginManager::GetManager()->Export(env, exports);
  return exports;
}
`,
    );
    cg = HomeGraph.initSync(testDir, {
      config: { include: ['**/*.{cpp,h,ts}'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('lists descriptor API names, not only Export shells', async () => {
    const res = await handler.execute('homegraph_explore', {
      query: 'feature/foldeffect 模块通过 NAPI 暴露了哪些 API 接口',
    });
    const text = res.content[0].text;
    expect(text).toMatch(/NAPI|native export/i);
    expect(text).toMatch(/\bdraw\b/);
    expect(text).toMatch(/finishDraw/);
    expect(text).toMatch(/ANSWER NOW/);
    expect(text).not.toMatch(/Init\/Export shells only/);
  });
});
