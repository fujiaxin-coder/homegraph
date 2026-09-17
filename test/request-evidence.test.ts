import { describe, expect, it } from 'vitest';
import { createRequestEvidenceInspector, type RequestSource } from '../src/mcp/request-evidence';
import type { RequestContract } from '../src/search/request-contract';
const contract: RequestContract = { targets: [
  { id: 'page', text: '账户设置', role: 'page', presence: 'existing', objectKind: 'ui' },
  { id: 'save', text: '保存', role: 'literal', presence: 'existing', objectKind: 'ui' },
], obligations: [{ id: 'enable', text: '输入完整后启用保存', kind: 'enabled', targetId: 'save' }] };
const unit = (source: string, filePath = 'Page.ets'): RequestSource => ({ source, filePath, start: 10 });
const result = (source: string) => createRequestEvidenceInspector({ ...contract, targets: contract.targets.filter(t => t.role !== 'page') }).inspect([unit(source)]);
const state = (source: string) => result(source).behaviors[0]!.status;
describe('request evidence from emitted current source', () => {
  it('prefers a page and control jointly over a same-label distractor or filename', () => {
    const inspect = createRequestEvidenceInspector(contract);
    const right = unit("build() { Column() { Text('账户设置'); Button('保存') } }");
    const wrong = unit("build() { Button('保存') }", '账户设置.ets');
    expect(inspect.score([right])).toBeGreaterThan(inspect.score([wrong]));
    expect(inspect.inspect([right, wrong]).targets[1]?.status).toBe('ambiguous');
  });
  it('uses returned page ownership to disambiguate a control on another page', () => {
    const inspect = createRequestEvidenceInspector(contract);
    const evidence = inspect.inspect([
      unit('build() { Text("账户设置"); Button("保存").enabled(this.ready) }', 'Correct.ets'),
      unit('build() { Button("保存") }', 'Other.ets'),
    ]);
    expect(evidence.behaviors[0]?.status).toBe('binding_observed');
    expect(evidence.behaviors[0]?.locations[0]).toContain('Correct.ets');
    expect(inspect.inspect([unit('build() { Button("保存").enabled(this.ready) }')]).behaviors[0]?.status).toBe('unknown');
  });
  it('requires framework evidence for a desktop form instead of matching Card names', () => {
    const inspect = createRequestEvidenceInspector({ targets: [{ id: 'form', text: 'QuickCard', role: 'symbol', presence: 'existing', objectKind: 'form' }], obligations: [] });
    expect(inspect.score([unit('@Component struct QuickCard { build() { Text("x") } }')])).toBe(0);
    expect(inspect.score([unit('class QuickCard extends FormExtensionAbility { onAddForm() {} }')])).toBeGreaterThan(0);
  });
  it('does not certify comments or stringified code', () => {
    expect(createRequestEvidenceInspector(contract).score([unit('// 账户设置 保存\nconst example = "Button(\'保存\')";')])).toBe(0);
    expect(state('// Button("保存").enabled(this.ready)\nfunction build() {}')).toBe('unknown');
  });
  it('keeps the appearance-only and click-guard case open', () => {
    expect(state('build() { Button("保存").backgroundColor(this.ready ? "blue" : "gray").onClick(() => { if (!this.ready) return; this.save(); }) }')).toBe('binding_not_observed');
  });
  it('recognizes target-local binding but explicitly leaves runtime correctness unverified', () => {
    const evidence = result('build() { Button("保存").enabled(this.ready).onClick(() => this.save()) }');
    expect(evidence.behaviors[0]?.status).toBe('binding_observed');
    expect(evidence.runtimeVerified).toBe(false); expect(evidence.behaviors[0]?.note).toContain('remain unverified');
  });
  it.each([
    'build() { Button("保存"); Button("取消").enabled(this.ready) }',
    'build() { Button("保存") /* .enabled(this.ready) */ }',
    'build() { Button("保存").onClick(() => { other.enabled(this.ready); }) }',
  ])('does not borrow another control or callback binding: %s', source => {
    expect(state(source)).toBe('binding_not_observed');
  });
  it('assigns a nested label to its outer interactive control', () => {
    expect(state('build() { Button() { Text("保存") }.enabled(this.ready) }')).toBe('binding_observed');
    expect(state('build() { Button() { Text("保存").enabled(this.ready) } }')).toBe('binding_not_observed');
  });
  it.each([
    'build() { Button("保存").enabled(true) }',
    'build() { Button("保存").enabled(this.ready).enabled(false) }',
    'build() { Button("保存").enabled(this.ready)',
    'build() { Button($r("app.string.save")).enabled(this.ready) }',
    'build() { Button("保存"); Button("保存").enabled(this.ready) }',
    'const example = /Button("保存").enabled(this.ready)/;',
    'const example = `Button("保存").enabled(${ready})`;',
  ])('leaves unsupported, constant or ambiguous cases unknown: %s', source => {
    expect(state(source)).toBe('unknown');
  });
  it('does not treat requested text absence or unsupported behavior as failures', () => {
    const inspect = createRequestEvidenceInspector({ targets: [{ id: 'new', text: '继续提交', role: 'literal', presence: 'requested' }], obligations: [{ id: 'life', kind: 'runtime', text: '切换后保持音频播放' }] });
    const evidence = inspect.inspect([]);
    expect(evidence.targets[0]?.status).toBe('requested_not_observed');
    expect(evidence.behaviors[0]?.status).toBe('unknown');
  });
});
