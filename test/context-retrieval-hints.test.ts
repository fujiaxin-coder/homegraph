import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import HomeGraph from '../src/index';
import type { FindRelevantContextOptions } from '../src/types';
import { removeTempDir } from './helpers/fs';

describe('ContextBuilder planned retrieval hints', () => {
  let dir: string;
  let graph: HomeGraph;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-hints-'));
    fs.writeFileSync(path.join(dir, 'payment.ts'), 'export class PaymentService { processPayment() { return 1; } }');
    fs.writeFileSync(path.join(dir, 'checkout.ts'), 'export class CheckoutController { checkout() { return 2; } }');
    graph = HomeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await graph.indexAll();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    graph?.destroy();
    removeTempDir(dir);
  });

  it('uses planned symbols instead of extracting unrelated original-query symbols', async () => {
    const exact = vi.spyOn(graph.getQueryBuilder(), 'findNodesByExactName');
    const result = await graph.findRelevantContext('CheckoutController', {
      traversalDepth: 0,
      retrievalHints: { symbols: ['PaymentService'], searchTerms: [] },
    });
    expect(exact.mock.calls[0]?.[0]).toEqual(['PaymentService']);
    expect(result.roots.map(id => result.nodes.get(id)?.name)).toContain('PaymentService');
    expect(result.roots.map(id => result.nodes.get(id)?.name)).not.toContain('CheckoutController');
  });

  it('reuses normalized terms once for FTS, rather than extracting them from the original query', async () => {
    const exact = vi.spyOn(graph.getQueryBuilder(), 'findNodesByExactName');
    const search = vi.spyOn(graph.getQueryBuilder(), 'searchNodes');
    const result = await graph.findRelevantContext('CheckoutController', {
      retrievalHints: { symbols: [], searchTerms: ['payment', 'PAYMENT', ' payment '] },
    });
    expect(exact).not.toHaveBeenCalled();
    expect(search.mock.calls.filter(([term]) => term === 'payment')).toHaveLength(1);
    expect(result.roots.map(id => result.nodes.get(id)?.name)).toContain('PaymentService');
  });

  it('does not silently re-extract query terms when the plan supplied empty hints', async () => {
    const search = vi.spyOn(graph.getQueryBuilder(), 'searchNodes');
    const result = await graph.findRelevantContext('PaymentService', {
      retrievalHints: { symbols: [], searchTerms: [] },
    });
    expect(result.nodes.size).toBe(0);
    expect(search).not.toHaveBeenCalled();
  });

  it('falls back to unchanged legacy retrieval when the hint shape is invalid', async () => {
    const baseline = await graph.findRelevantContext('PaymentService');
    const result = await graph.findRelevantContext('PaymentService', {
      retrievalHints: { symbols: 'PaymentService', searchTerms: [] } as unknown as FindRelevantContextOptions['retrievalHints'],
    });
    expect(result.roots).toEqual(baseline.roots);
  });

  it('bounds and sanitizes hints before issuing real database queries', async () => {
    const exact = vi.spyOn(graph.getQueryBuilder(), 'findNodesByExactName');
    const inputs: unknown[] = ['PaymentService', 'PaymentService', '', '\u0000bad', 'x'.repeat(257), 42,
      ...Array.from({ length: 40 }, (_, i) => `MissingSymbol${i}`)];
    await graph.findRelevantContext('CheckoutController', {
      retrievalHints: { symbols: inputs as string[], searchTerms: [] },
    });
    const supplied = exact.mock.calls[0]?.[0] ?? [];
    expect(supplied.length).toBeLessThanOrEqual(32);
    expect(supplied.filter(value => value === 'PaymentService')).toHaveLength(1);
    expect(supplied).not.toContain('MissingSymbol39');
    expect(supplied.every(value => value.length <= 256 && !value.includes('\u0000'))).toBe(true);
  });

  it('does not manufacture graph evidence from an unresolved planned symbol', async () => {
    const result = await graph.findRelevantContext('PaymentService', {
      retrievalHints: { symbols: ['DoesNotExistAnywhere'], searchTerms: [] },
    });
    expect(result.nodes.size).toBe(0);
  });

  it('retains the exact file identity of a bound node instead of searching its namesake', async () => {
    fs.writeFileSync(path.join(dir, 'other-payment.ts'), 'export class PaymentService { anotherPayment() { return 3; } }');
    await graph.indexAll();
    const target = graph.getQueryBuilder().findNodesByExactName(['PaymentService'], { limit: 20 })
      .find(hit => hit.node.filePath.endsWith('other-payment.ts'))!.node;
    const exact = vi.spyOn(graph.getQueryBuilder(), 'findNodesByExactName');
    const result = await graph.findRelevantContext('CheckoutController', {
      traversalDepth: 0,
      retrievalHints: { symbols: [], searchTerms: [], nodeIds: [target.id] },
    });
    expect(exact).not.toHaveBeenCalled();
    expect(result.roots).toEqual([target.id]);
    expect([...result.nodes.values()].map(node => node.filePath)).toEqual([target.filePath]);
  });

  it('supports a file-node-only identity hint without requiring a lexical query', async () => {
    const target = graph.getQueryBuilder().searchNodes('payment.ts', { kinds: ['file'], limit: 10 })[0]!.node;
    const result = await graph.findRelevantContext('', {
      traversalDepth: 0,
      retrievalHints: { symbols: [], searchTerms: [], nodeIds: [target.id] },
    });
    expect(result.roots).toEqual([target.id]);
    expect(result.nodes.get(target.id)?.kind).toBe('file');
  });

  it('does not fabricate evidence for stale or missing node identities', async () => {
    const target = graph.getQueryBuilder().findNodesByExactName(['PaymentService'], { limit: 10 })[0]!.node;
    graph.getQueryBuilder().getNodeById(target.id); // Prime the same API cache used by retrieval.
    graph.getQueryBuilder().deleteNode(target.id);
    const result = await graph.findRelevantContext('PaymentService', {
      retrievalHints: { symbols: [], searchTerms: [], nodeIds: [target.id, 'class:does-not-exist'] },
    });
    expect(result.nodes.size).toBe(0);
    expect(result.roots).toEqual([]);
  });

  it('bounds and rejects malformed identity hints before exact ID lookups', async () => {
    const lookup = vi.spyOn(graph.getQueryBuilder(), 'getNodeById');
    const ids: unknown[] = [' missing-id ', 'missing-id', '', '\u0000bad', 'x'.repeat(257), 42,
      ...Array.from({ length: 40 }, (_, i) => `absent-id-${i}`)];
    const result = await graph.findRelevantContext('PaymentService', {
      retrievalHints: { symbols: [], searchTerms: [], nodeIds: ids as string[] },
    });
    const supplied = lookup.mock.calls.map(([id]) => id);
    expect(supplied.length).toBeGreaterThan(0);
    expect(supplied.length).toBeLessThanOrEqual(32);
    expect(supplied.filter(id => id === 'missing-id')).toHaveLength(1);
    expect(supplied).not.toContain('absent-id-39');
    expect(supplied.every(id => typeof id === 'string' && id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(id))).toBe(true);
    expect(result.nodes.size).toBe(0);
  });

  it('ignores an invalid nodeIds shape without re-extracting the original query', async () => {
    const lookup = vi.spyOn(graph.getQueryBuilder(), 'getNodeById');
    const result = await graph.findRelevantContext('PaymentService', {
      retrievalHints: { symbols: [], searchTerms: [], nodeIds: 'PaymentService' } as unknown as FindRelevantContextOptions['retrievalHints'],
    });
    expect(result.nodes.size).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('reserves a bounded root slot for an exact identity despite competing lexical ranks', async () => {
    const target = graph.getQueryBuilder().findNodesByExactName(['PaymentService'], { limit: 10 })[0]!.node;
    const result = await graph.findRelevantContext('CheckoutController', {
      searchLimit: 1, traversalDepth: 0, minScore: Number.MAX_SAFE_INTEGER,
      retrievalHints: { symbols: ['CheckoutController'], searchTerms: ['checkout'], nodeIds: [target.id] },
    });
    expect(result.roots).toEqual([target.id]);
    expect([...result.nodes.keys()]).toEqual([target.id]);
  });

  it('keeps roots and graph within the total node budget when many identities are supplied', async () => {
    const targets = graph.getQueryBuilder().findNodesByExactName(['PaymentService', 'CheckoutController'], { limit: 10 })
      .map(hit => hit.node.id);
    const result = await graph.findRelevantContext('payment checkout', {
      searchLimit: 10, maxNodes: 1, traversalDepth: 2,
      retrievalHints: { symbols: ['PaymentService', 'CheckoutController'], searchTerms: [], nodeIds: targets },
    });
    expect(result.nodes.size).toBe(1);
    expect(result.roots).toEqual([targets[0]]);
    expect(result.roots.every(id => result.nodes.has(id))).toBe(true);
    expect(result.edges.every(edge => result.nodes.has(edge.source) && result.nodes.has(edge.target))).toBe(true);
  });

  it('does not discard explicitly bound test-file identities through diversity caps', async () => {
    fs.writeFileSync(path.join(dir, 'components.test.ts'),
      Array.from({ length: 8 }, (_, i) => `export class BoundComponent${i} {}`).join('\n'));
    await graph.indexAll();
    const targets = graph.getQueryBuilder().findNodesByExactName(
      Array.from({ length: 8 }, (_, i) => `BoundComponent${i}`), { limit: 20 }).map(hit => hit.node.id);
    const result = await graph.findRelevantContext('component', {
      searchLimit: 8, maxNodes: 8, traversalDepth: 0,
      retrievalHints: { symbols: [], searchTerms: [], nodeIds: targets },
    });
    expect(result.roots).toEqual(targets);
    expect(new Set(result.nodes.keys())).toEqual(new Set(targets));
  });

  it('does not expand an identity-only root through type hierarchy at depth zero', async () => {
    fs.writeFileSync(path.join(dir, 'hierarchy.ts'), 'class Ancestor {}\nexport class Child extends Ancestor {}');
    await graph.indexAll();
    const target = graph.getQueryBuilder().findNodesByExactName(['Child'], { limit: 10 })[0]!.node;
    const result = await graph.findRelevantContext('Child', {
      traversalDepth: 0,
      retrievalHints: { symbols: [], searchTerms: [], nodeIds: [target.id] },
    });
    expect([...result.nodes.keys()]).toEqual([target.id]);
    expect(result.edges).toEqual([]);
  });

  it('uses exact identities as traversal roots and respects an explicit node-kind filter', async () => {
    const target = graph.getQueryBuilder().findNodesByExactName(['PaymentService'], { limit: 10 })[0]!.node;
    const result = await graph.findRelevantContext('PaymentService', {
      nodeKinds: ['method'],
      retrievalHints: { symbols: [], searchTerms: [], nodeIds: [target.id] },
    });
    expect(result.nodes.size).toBe(0);
    const expanded = await graph.findRelevantContext('CheckoutController', {
      traversalDepth: 1,
      retrievalHints: { symbols: [], searchTerms: [], nodeIds: [target.id] },
    });
    expect(expanded.roots).toEqual([target.id]);
    expect([...expanded.nodes.values()].map(node => node.name)).toContain('processPayment');
    expect([...expanded.nodes.values()].map(node => node.name)).not.toContain('CheckoutController');
  });

  it('preserves the prior symbol-hint behavior when nodeIds is omitted or empty', async () => {
    const baseline = await graph.findRelevantContext('CheckoutController', {
      retrievalHints: { symbols: ['PaymentService'], searchTerms: ['payment'] },
    });
    const result = await graph.findRelevantContext('CheckoutController', {
      retrievalHints: { symbols: ['PaymentService'], searchTerms: ['payment'], nodeIds: [] },
    });
    expect(result.roots).toEqual(baseline.roots);
    expect([...result.nodes.keys()]).toEqual([...baseline.nodes.keys()]);
    expect(result.edges).toEqual(baseline.edges);
  });
});
