/**
 * Unit tests for ArkUI migrate semantics helpers + snapshot assembly (spec 0007).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyPassageFromText,
  classifyValueType,
  computeForcesMigration,
  decodeDecorators,
  encodeDecoratorEntries,
  parseDecoratorArgFromContent,
  scanStorageApiKeys,
} from '../../../src/arkui/migrate-semantics';
import {
  buildArkUIMigrateSnapshot,
  type MigrateSnapshotGraph,
} from '../../../src/arkui/migrate-snapshot';
import type { Edge, Node } from '../../../src/types';
import { cleanupArktsProjects } from './helpers';

afterEach(() => {
  cleanupArktsProjects();
});

describe('arkui migrate-semantics helpers', () => {
  it('parses decorator string args from getContent()', () => {
    expect(parseDecoratorArgFromContent("Provide('theme')")).toBe('theme');
    expect(parseDecoratorArgFromContent('StorageLink("count")')).toBe('count');
    expect(parseDecoratorArgFromContent('State')).toBeNull();
  });

  it('encodes/decodes Kind@arg twins without dropping bare kinds', () => {
    const encoded = encodeDecoratorEntries([
      { kind: 'Provide', arg: 'theme' },
      { kind: 'Watch', arg: 'onChange' },
    ]);
    expect(encoded).toEqual(
      expect.arrayContaining(['Provide', 'Provide@theme', 'Watch', 'Watch@onChange'])
    );
    const { kinds, argByKind } = decodeDecorators(encoded);
    expect(kinds).toEqual(expect.arrayContaining(['Provide', 'Watch']));
    expect(argByKind.get('Provide')).toBe('theme');
    expect(argByKind.get('Watch')).toBe('onChange');
  });

  it('classifies passage + forcesMigration like migration-graph', () => {
    expect(classifyPassageFromText('$$this.count')).toBe('two_way_binding');
    expect(classifyPassageFromText('this.count')).toBe('state_variable_ref');
    expect(classifyPassageFromText("'hi'")).toBe('literal');
    expect(classifyValueType('number')).toBe('simple');
    expect(classifyValueType('string[]')).toBe('builtin');
    expect(classifyValueType('UserProfile')).toBe('class');
    expect(computeForcesMigration('two_way_binding', 'simple')).toBe(true);
    expect(computeForcesMigration('state_variable_ref', 'simple')).toBe(false);
    expect(computeForcesMigration('state_variable_ref', 'class')).toBe(true);
    expect(computeForcesMigration('literal', 'class')).toBe(false);
  });

  it('scans AppStorage / LocalStorage literal keys', () => {
    const hits = scanStorageApiKeys(`
      AppStorage.setOrCreate('theme', 'dark');
      LocalStorage.link('count');
    `);
    expect(hits.map((h) => `${h.channel}:${h.key}`).sort()).toEqual([
      'AppStorage:theme',
      'LocalStorage:count',
    ]);
  });
});

describe('arkui migrate-snapshot assembly', () => {
  function node(
    partial: Partial<Node> & Pick<Node, 'id' | 'kind' | 'name' | 'filePath'>
  ): Node {
    return {
      language: 'arkts',
      qualifiedName: partial.name,
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
      ...partial,
    };
  }

  it('builds snapshot with passages, key channels, and observed refs', () => {
    const parent = node({
      id: 'comp:Parent',
      kind: 'component',
      name: 'Parent',
      filePath: 'Parent.ets',
      decorators: ['Component', 'Entry'],
    });
    const parentStruct = node({
      id: 'struct:Parent',
      kind: 'struct',
      name: 'Parent',
      filePath: 'Parent.ets',
      decorators: ['Component', 'Entry'],
    });
    const child = node({
      id: 'comp:Child',
      kind: 'component',
      name: 'Child',
      filePath: 'Child.ets',
      decorators: ['Component'],
    });
    const childStruct = node({
      id: 'struct:Child',
      kind: 'struct',
      name: 'Child',
      filePath: 'Child.ets',
      decorators: ['Component'],
    });
    const stateField = node({
      id: 'field:Parent.count',
      kind: 'property',
      name: 'count',
      filePath: 'Parent.ets',
      decorators: ['State'],
      signature: 'number',
      qualifiedName: 'Parent.count',
    });
    const provideField = node({
      id: 'field:Parent.theme',
      kind: 'property',
      name: 'theme',
      filePath: 'Parent.ets',
      decorators: ['Provide', 'Provide@theme'],
      signature: 'string',
      qualifiedName: 'Parent.theme',
    });
    const propField = node({
      id: 'field:Child.count',
      kind: 'property',
      name: 'count',
      filePath: 'Child.ets',
      decorators: ['Prop'],
      signature: 'number',
      qualifiedName: 'Child.count',
    });
    const consumeField = node({
      id: 'field:Child.theme',
      kind: 'property',
      name: 'theme',
      filePath: 'Child.ets',
      decorators: ['Consume', 'Consume@theme'],
      signature: 'string',
      qualifiedName: 'Child.theme',
    });
    const observed = node({
      id: 'class:Profile',
      kind: 'class',
      name: 'Profile',
      filePath: 'Profile.ets',
      decorators: ['Observed'],
    });
    const trackField = node({
      id: 'field:Profile.name',
      kind: 'property',
      name: 'name',
      filePath: 'Profile.ets',
      decorators: ['Track'],
      signature: 'string',
    });
    const profileState = node({
      id: 'field:Parent.profile',
      kind: 'property',
      name: 'profile',
      filePath: 'Parent.ets',
      decorators: ['State'],
      signature: 'Profile',
      qualifiedName: 'Parent.profile',
    });

    const nodes = [
      parent,
      parentStruct,
      child,
      childStruct,
      stateField,
      provideField,
      propField,
      consumeField,
      observed,
      trackField,
      profileState,
    ];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges: Edge[] = [
      { source: parentStruct.id, target: stateField.id, kind: 'contains' },
      { source: parentStruct.id, target: provideField.id, kind: 'contains' },
      { source: parentStruct.id, target: profileState.id, kind: 'contains' },
      { source: childStruct.id, target: propField.id, kind: 'contains' },
      { source: childStruct.id, target: consumeField.id, kind: 'contains' },
      { source: observed.id, target: trackField.id, kind: 'contains' },
      {
        source: stateField.id,
        target: propField.id,
        kind: 'references',
        metadata: {
          synthesizedBy: 'viewtree',
          via: 'Prop',
          passageType: 'state_variable_ref',
          valueType: 'simple',
          forcesMigration: false,
          parentExpression: 'this.count',
          registeredAt: 'Parent.ets:8',
        },
      },
      {
        source: profileState.id,
        target: observed.id,
        kind: 'references',
        metadata: { synthesizedBy: 'arkui-migrate', via: 'observed-ref' },
      },
      {
        source: parent.id,
        target: parent.id,
        kind: 'references',
        metadata: {
          synthesizedBy: 'arkui-migrate',
          via: 'storage-api',
          channel: 'AppStorage',
          key: 'globalTheme',
          method: 'setOrCreate',
        },
      },
    ];

    const graph: MigrateSnapshotGraph = {
      getNodesByKind: (kind) => nodes.filter((n) => n.kind === kind),
      getNodesByName: (name) => nodes.filter((n) => n.name === name),
      getNodesInFile: (fp) => nodes.filter((n) => n.filePath === fp),
      getOutgoingEdges: (id) => edges.filter((e) => e.source === id),
      getIncomingEdges: (id) => edges.filter((e) => e.target === id),
      getNode: (id) => byId.get(id) ?? null,
    };

    const snap = buildArkUIMigrateSnapshot(graph, 'Parent');
    expect(snap.scope.resolved).toBe('component');
    expect(snap.components).toHaveLength(1);
    expect(snap.components[0]!.name).toBe('Parent');
    expect(snap.components[0]!.isEntry).toBe(true);
    expect(snap.components[0]!.stateVars.map((s) => s.decorator).sort()).toEqual([
      'Provide',
      'State',
      'State',
    ]);
    expect(snap.components[0]!.stateVars.find((s) => s.name === 'theme')?.decoratorArg).toBe(
      'theme'
    );

    expect(snap.dataPassages.some((p) => p.passageType === 'state_variable_ref')).toBe(true);
    expect(snap.keyChannels.some((k) => k.key === 'theme' && k.channel === 'ProvideConsume')).toBe(
      true
    );
    // Provide on Parent only in this scope — Consume is on Child; channel still lists Parent provide
    expect(snap.keyChannels.some((k) => k.key === 'globalTheme' && k.channel === 'AppStorage')).toBe(
      true
    );
    expect(snap.observedClasses).toHaveLength(1);
    expect(snap.observedClasses[0]!.name).toBe('Profile');
    expect(snap.observedClasses[0]!.properties[0]?.hasTrace).toBe(true);
    expect(snap.observedClasses[0]!.referencedBy).toContain(profileState.id);
  });

  it('collectObserved skips full-graph class/struct scans (spec 0013)', () => {
    const parent = node({
      id: 'comp:Host',
      kind: 'component',
      name: 'Host',
      filePath: 'Host.ets',
      decorators: ['Component'],
    });
    const parentStruct = node({
      id: 'struct:Host',
      kind: 'struct',
      name: 'Host',
      filePath: 'Host.ets',
      decorators: ['Component'],
    });
    const localObserved = node({
      id: 'class:LocalModel',
      kind: 'class',
      name: 'LocalModel',
      filePath: 'Host.ets',
      decorators: ['Observed'],
    });
    const remoteObserved = node({
      id: 'class:RemoteModel',
      kind: 'class',
      name: 'RemoteModel',
      filePath: 'Remote.ets',
      decorators: ['Observed'],
    });
    const unrelatedObserved = node({
      id: 'class:Unrelated',
      kind: 'class',
      name: 'Unrelated',
      filePath: 'Other.ets',
      decorators: ['Observed'],
    });
    const profileState = node({
      id: 'field:Host.remote',
      kind: 'property',
      name: 'remote',
      filePath: 'Host.ets',
      decorators: ['State'],
      signature: 'RemoteModel',
      qualifiedName: 'Host.remote',
    });
    // Noise: many Observed classes that must never be loaded via getNodesByKind
    const noise: Node[] = Array.from({ length: 200 }, (_, i) =>
      node({
        id: `class:Noise${i}`,
        kind: 'class',
        name: `Noise${i}`,
        filePath: `noise/Noise${i}.ets`,
        decorators: ['Observed'],
      })
    );

    const nodes = [
      parent,
      parentStruct,
      localObserved,
      remoteObserved,
      unrelatedObserved,
      profileState,
      ...noise,
    ];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges: Edge[] = [
      { source: parentStruct.id, target: profileState.id, kind: 'contains' },
      {
        source: profileState.id,
        target: remoteObserved.id,
        kind: 'references',
        metadata: { synthesizedBy: 'arkui-migrate', via: 'observed-ref' },
      },
      // storage-api must not count as observed-ref
      {
        source: profileState.id,
        target: unrelatedObserved.id,
        kind: 'references',
        metadata: {
          synthesizedBy: 'arkui-migrate',
          via: 'storage-api',
          channel: 'AppStorage',
          key: 'x',
        },
      },
    ];

    let kindClassCalls = 0;
    let kindStructCalls = 0;
    const graph: MigrateSnapshotGraph = {
      getNodesByKind: (kind) => {
        if (kind === 'class') kindClassCalls += 1;
        if (kind === 'struct') kindStructCalls += 1;
        return nodes.filter((n) => n.kind === kind);
      },
      getNodesByName: (name) => nodes.filter((n) => n.name === name),
      getNodesInFile: (fp) => nodes.filter((n) => n.filePath === fp),
      getOutgoingEdges: (id) => edges.filter((e) => e.source === id),
      getIncomingEdges: (id) => edges.filter((e) => e.target === id),
      getNode: (id) => byId.get(id) ?? null,
    };

    const snap = buildArkUIMigrateSnapshot(graph, 'Host');
    expect(kindClassCalls).toBe(0);
    // resolveScope may still touch struct for directory fallbacks; component-name
    // resolution uses getNodesByName only — struct kind must stay 0 here.
    expect(kindStructCalls).toBe(0);

    const names = snap.observedClasses.map((o) => o.name).sort();
    expect(names).toEqual(['LocalModel', 'RemoteModel']);
    const remote = snap.observedClasses.find((o) => o.name === 'RemoteModel')!;
    expect(remote.referencedBy).toEqual([profileState.id]);
    const local = snap.observedClasses.find((o) => o.name === 'LocalModel')!;
    expect(local.referencedBy).toEqual([]);
    expect(snap.observedClasses.some((o) => o.name === 'Unrelated')).toBe(false);
  });
});
