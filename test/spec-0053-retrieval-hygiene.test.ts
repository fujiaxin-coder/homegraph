/**
 * Spec 0053 — explore call-budget text, CJK search path, synthesized_by deletes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { backfillEdgeSynthesizedBy } from '../src/db/migrations';
import type { Node } from '../src/types';

function makeNode(id: string, name = id): Node {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: name,
    filePath: 'a.ets',
    language: 'arkts',
    startLine: 1,
    endLine: 2,
    startColumn: 0,
    endColumn: 1,
    updatedAt: Date.now(),
  };
}

describe('Spec 0053 retrieval hygiene', () => {
  describe('search and channel delete', () => {
    let dir: string;
    let db: DatabaseConnection;
    let q: QueryBuilder;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-0053-'));
      db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
      q = new QueryBuilder(db.getDb());
    });

    afterEach(() => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('finds Chinese docstring text via FTS and a name substring via LIKE', () => {
      const page = makeNode('page', '用户登录页');
      const resource = makeNode('submit_order', 'submit_order');
      resource.docstring = '提交订单';
      resource.signature = "$r('app.string.submit_order')";
      q.insertNodes([page, resource, makeNode('auth', 'AuthService')]);
      const mid = q.searchNodes('登录').map((r) => r.node.name);
      expect(mid).toContain('用户登录页');
      const value = q.searchNodes('提交订单').map((r) => r.node.name);
      expect(value).toContain('submit_order');
      const mixed = q.searchNodes('Auth 登录').map((r) => r.node.name);
      expect(mixed).toContain('AuthService');
    });

    it('deletes arkanalyzer cross-file calls by synthesized_by, not JSON key order', () => {
      q.insertNodes([makeNode('a'), makeNode('b'), makeNode('c'), makeNode('d')]);
      db.getDb().exec(`
        INSERT INTO edges (source, target, kind, metadata, provenance, synthesized_by)
        VALUES
          ('a', 'b', 'calls', '{"sourceFile":"x.ets","synthesizedBy":"arkanalyzer"}', 'heuristic', NULL),
          ('c', 'd', 'calls', '{"synthesizedBy":"callback","sourceFile":"y.ets"}', 'heuristic', NULL);
      `);
      backfillEdgeSynthesizedBy(db.getDb());
      const before = db.getDb().prepare(
        'SELECT source, synthesized_by AS by FROM edges ORDER BY source',
      ).all() as Array<{ source: string; by: string }>;
      expect(before).toEqual([
        { source: 'a', by: 'arkanalyzer' },
        { source: 'c', by: 'callback' },
      ]);

      expect(q.deleteArkTSCrossFileCallEdges()).toBe(1);
      const left = db.getDb().prepare('SELECT source FROM edges').all() as Array<{ source: string }>;
      expect(left.map((r) => r.source)).toEqual(['c']);
    });

    it('writes synthesized_by on insertEdge', () => {
      q.insertNodes([makeNode('s'), makeNode('t')]);
      q.insertEdge({
        source: 's',
        target: 't',
        kind: 'calls',
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'arkui-child', sourceFile: 'p.ets' },
      });
      const row = db.getDb().prepare(
        'SELECT synthesized_by AS by FROM edges WHERE source = ?',
      ).get('s') as { by: string };
      expect(row.by).toBe('arkui-child');
    });
  });
});
