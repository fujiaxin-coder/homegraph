/**
 * Spec 0048 — Harmony capability profiles, Resource bound, module roster, seam notes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HomeGraph } from '../../../src';
import {
  isHarmonyCapabilityProfileJson,
  isSourceFile,
  detectLanguage,
} from '../../../src/extraction/grammars';
import {
  parseHarmonyFormConfig,
  parseHarmonyShortcutsConfig,
} from '../../../src/resolution/frameworks/arkts-entry';
import {
  formatHarmonyCapabilityProfiles,
  formatHarmonyResourceHits,
  formatHarmonySeamNotes,
  isHarmonyStubBody,
  ToolHandler,
} from '../../../src/mcp/tools';
import {
  formatHarmonyModuleRoster,
  scanHarmonyResourceInventory,
} from '../../../src/project-map';
import { SERVER_INSTRUCTIONS } from '../../../src/mcp/server-instructions';
import { cleanupArktsProjects, makeArktsProject } from './helpers';

afterEach(() => {
  cleanupArktsProjects();
});

const CAPABILITY_FIXTURE = {
  'entry/src/main/resources/base/profile/form_config.json': `{
  "forms": [
    { "name": "MusicCard", "description": "music" }
  ]
}`,
  'entry/src/main/resources/base/profile/shortcuts_config.json': `{
  "shortcuts": [
    {
      "shortcutId": "id_components",
      "label": "$string:shortcut_components",
      "wants": [{ "abilityName": "EntryAbility", "moduleName": "entry" }]
    }
  ]
}`,
  'entry/src/main/resources/base/element/string.json': `{
  "string": [
    { "name": "shortcut_components", "value": "组件案例" },
    { "name": "submit_order", "value": "提交订单" }
  ]
}`,
  'entry/src/main/module.json5': `{
  "module": {
    "name": "entry",
    "type": "entry",
    "abilities": [
      {
        "name": "EntryAbility",
        "srcEntry": "./ets/entryability/EntryAbility.ets",
        "metadata": [
          {
            "name": "ohos.ability.shortcuts",
            "resource": "$profile:shortcuts_config"
          }
        ]
      }
    ],
    "extensionAbilities": [
      {
        "name": "EntryFormAbility",
        "srcEntry": "./ets/entryformability/EntryFormAbility.ets",
        "type": "form",
        "metadata": [
          {
            "name": "ohos.extension.form",
            "resource": "$profile:form_config"
          }
        ]
      }
    ]
  }
}`,
  'entry/src/main/ets/pages/Index.ets': `
@Entry
@Component
struct Index {
  build(): void {
    Text($r('app.string.submit_order'))
  }
}
`,
  'entry/src/main/ets/service/MediaService.ets': `
export class MediaService {
  play(): void {
    console.info('disabled');
  }
}
`,
  'libs/module_compass/oh-package.json5': `{
  "name": "@ohos/module_compass",
  "dependencies": {
    "@ohos/module_clock": "file:../module_clock"
  }
}`,
  'libs/module_compass/src/main/module.json5': `{
  "module": { "name": "module_compass", "type": "har" }
}`,
  'libs/module_compass/src/main/ets/Index.ets': `
export function compassReady(): void {}
`,
  'libs/module_clock/oh-package.json5': `{
  "name": "@ohos/module_clock",
  "dependencies": {}
}`,
  'libs/module_clock/src/main/module.json5': `{
  "module": { "name": "module_clock", "type": "har" }
}`,
  'libs/module_clock/src/main/ets/Index.ets': `
export function clockReady(): void {}
`,
  'build-profile.json5': `{
  "modules": [
    { "name": "entry", "srcPath": "./entry" },
    { "name": "module_compass", "srcPath": "./libs/module_compass" },
    { "name": "module_clock", "srcPath": "./libs/module_clock" }
  ]
}`,
};

describe('Spec 0048 harmony capability profiles and locate seams', () => {
  it('allowlists form_config / shortcuts_config basenames', () => {
    expect(isHarmonyCapabilityProfileJson('a/form_config.json')).toBe(true);
    expect(isHarmonyCapabilityProfileJson('a/shortcuts_config.json')).toBe(true);
    expect(isHarmonyCapabilityProfileJson('a/route_map.json')).toBe(false);
    expect(isSourceFile('entry/src/main/resources/base/profile/form_config.json')).toBe(true);
    expect(detectLanguage('x/shortcuts_config.json')).toBe('yaml');
  });

  it('parses form and shortcuts profiles', () => {
    expect(parseHarmonyFormConfig(CAPABILITY_FIXTURE['entry/src/main/resources/base/profile/form_config.json']!))
      .toEqual([{ name: 'MusicCard', line: expect.any(Number) }]);
    const shortcuts = parseHarmonyShortcutsConfig(
      CAPABILITY_FIXTURE['entry/src/main/resources/base/profile/shortcuts_config.json']!,
    );
    expect(shortcuts[0]?.shortcutId).toBe('id_components');
    expect(shortcuts[0]?.abilityName).toBe('EntryAbility');
  });

  it('indexes capability nodes and surfaces profiles / negative form evidence', async () => {
    const root = makeArktsProject(CAPABILITY_FIXTURE);
    const cg = HomeGraph.initSync(root);
    await cg.indexAll();
    cg.setBuildPhase('full');

    const forms = cg.getNodesByKind('constant')
      .filter((n) => /form_config\.json$/i.test(n.filePath));
    expect(forms.some((n) => n.name === 'MusicCard')).toBe(true);

    const shortcuts = cg.getNodesByKind('constant')
      .filter((n) => /shortcuts_config\.json$/i.test(n.filePath));
    expect(shortcuts.some((n) => n.name === 'id_components')).toBe(true);

    const formAbility = cg.getNodesByKind('route')
      .find((n) => n.name === 'formAbility:EntryFormAbility');
    const formMeta = cg.getNodesByKind('constant')
      .find((n) => n.name === 'ohos.extension.form' || (n.qualifiedName ?? '').includes('harmony.capability.form'));
    expect(formAbility || formMeta || forms.length > 0).toBeTruthy();

    const withForm = formatHarmonyCapabilityProfiles(cg, '服务卡片 form_config');
    expect(withForm).toContain('Capability profiles');
    expect(withForm).toMatch(/MusicCard|formAbility:|ohos\.extension\.form/);

    const withShortcut = formatHarmonyCapabilityProfiles(cg, '长按图标快捷入口 shortcuts');
    expect(withShortcut).toContain('id_components');

    // Negative: empty project shape — no form nodes.
    const emptyRoot = makeArktsProject({
      'entry/src/main/ets/pages/Index.ets': `
@Entry
@Component
struct Index { build(): void {} }
`,
      'entry/src/main/module.json5': `{ "module": { "name": "entry", "type": "entry" } }`,
    });
    const emptyCg = HomeGraph.initSync(emptyRoot);
    await emptyCg.indexAll();
    const neg = formatHarmonyCapabilityProfiles(emptyCg, '服务卡片 FormExtension');
    expect(neg).toMatch(/No in-repo form_config/);
    emptyCg.close();

    const handler = new ToolHandler(cg);
    const res = await handler.execute('homegraph_explore', {
      query: '桌面快捷方式 shortcuts_config 长按',
    });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Capability profiles');
    expect(text).toContain('id_components');

    cg.close();
  });

  it('Resource hits include bound .ets anchors when $r is present', async () => {
    const root = makeArktsProject(CAPABILITY_FIXTURE);
    const cg = HomeGraph.initSync(root);
    await cg.indexAll();
    const section = formatHarmonyResourceHits(cg, '提交订单 string.json');
    expect(section).toContain('submit_order');
    expect(section).toMatch(/bound `entry\/src\/main\/ets\/pages\/Index\.ets:\d+`/);
    cg.close();
  });

  it('project map lists Module roster and capability profile paths', async () => {
    const root = makeArktsProject(CAPABILITY_FIXTURE);
    const cg = HomeGraph.initSync(root);
    await cg.indexAll();
    cg.setBuildPhase('full');
    cg.buildProjectMap();
    const handler = new ToolHandler(cg);
    const res = await handler.execute('homegraph_project', { includeFiles: false });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Module roster');
    expect(text).toMatch(/module_compass/);
    expect(text).toMatch(/file:\.\.\/module_clock/);
    expect(text).toMatch(/capability profiles/);
    expect(text).toMatch(/form_config\.json|shortcuts_config\.json/);

    const inv = scanHarmonyResourceInventory(root);
    expect(inv.capabilityProfiles.some((p) => p.endsWith('form_config.json'))).toBe(true);
    const roster = formatHarmonyModuleRoster(root, cg.getProjectMap({ includeFiles: false }).modules);
    expect(roster).toContain('Module roster');
    cg.close();
  });

  it('detects stub bodies and emits Seam notes', async () => {
    expect(isHarmonyStubBody(`play(): void {\n  console.info('disabled');\n}`)).toBe(true);
    expect(isHarmonyStubBody(`play(): void {\n  this.player.start();\n  this.updateUi();\n}`)).toBe(false);

    const root = makeArktsProject(CAPABILITY_FIXTURE);
    const cg = HomeGraph.initSync(root);
    await cg.indexAll();
    const play = cg.getNodesByName('play').find((n) => n.filePath.includes('MediaService'));
    expect(play).toBeDefined();
    const seams = formatHarmonySeamNotes(cg, root, [{
      id: play!.id,
      name: play!.name,
      filePath: play!.filePath,
      startLine: play!.startLine,
    }]);
    expect(seams).toContain('Seam notes');
    expect(seams).toMatch(/stub: `play`/);
    cg.close();
  });

  it('instructions mention capability profiles and module roster', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/form_config|Capability profiles/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/Module roster|file:/i);
  });
});
