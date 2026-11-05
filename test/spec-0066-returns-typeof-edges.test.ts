/**
 * Spec 0066 — `returns` / `type_of` edges + JSDoc type-tag fallback.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HomeGraph } from '../src';
import {
  extractBaseTypeName,
  parseJsdocParams,
  parseJsdocReturns,
} from '../src/extraction/jsdoc-type-tags';

describe('Spec 0066 jsdoc-type-tags helpers', () => {
  it('extractBaseTypeName unwraps Promise and strips primitives', () => {
    expect(extractBaseTypeName('Promise<User>')).toBe('User');
    expect(extractBaseTypeName('User[]')).toBe('User');
    expect(extractBaseTypeName('string')).toBeUndefined();
    expect(extractBaseTypeName('void')).toBeUndefined();
  });

  it('parseJsdocReturns / parseJsdocParams read curly types', () => {
    const doc = `
 * Creates a user.
 * @param {Account} account - source
 * @returns {User}
 `;
    expect(parseJsdocReturns(doc)).toBe('User');
    expect(parseJsdocParams(doc)).toEqual([{ paramName: 'account', typeName: 'Account' }]);
  });
});

describe('Spec 0066 returns / type_of edges (TypeScript)', () => {
  let tempDir: string;
  let cg: HomeGraph;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-0066-'));
  });

  afterEach(() => {
    if (cg) cg.close();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('links method return and param types as returns / type_of; reverse lookup works', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'models.ts'),
      `export class User {
  name: string = '';
}

export class Account {
  id: number = 0;
}
`
    );
    fs.writeFileSync(
      path.join(tempDir, 'service.ts'),
      `import { User, Account } from './models';

export class UserService {
  find(account: Account): User {
    return new User();
  }
}
`
    );

    cg = HomeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const user = cg.getNodesByKind('class').find((n) => n.name === 'User');
    const account = cg.getNodesByKind('class').find((n) => n.name === 'Account');
    const find = cg.getNodesByKind('method').find((n) => n.name === 'find');
    expect(user).toBeDefined();
    expect(account).toBeDefined();
    expect(find).toBeDefined();

    const out = cg.getOutgoingEdges(find!.id);
    expect(out.some((e) => e.kind === 'returns' && e.target === user!.id)).toBe(true);
    expect(out.some((e) => e.kind === 'type_of' && e.target === account!.id)).toBe(true);

    // Reverse: type node incoming returns / type_of
    const userIn = cg.getIncomingEdges(user!.id);
    expect(userIn.some((e) => e.kind === 'returns' && e.source === find!.id)).toBe(true);
    const accountIn = cg.getIncomingEdges(account!.id);
    expect(accountIn.some((e) => e.kind === 'type_of' && e.source === find!.id)).toBe(true);
  });

  it('does not link when the type name is ambiguous across files', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'a.ts'),
      `export class Token { value = 1; }
`
    );
    fs.writeFileSync(
      path.join(tempDir, 'b.ts'),
      `export class Token { value = 2; }
`
    );
    fs.writeFileSync(
      path.join(tempDir, 'c.ts'),
      `export function mint(): Token {
  return null as any;
}
`
    );

    cg = HomeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const mint = cg
      .getNodesByKind('function')
      .find((n) => n.name === 'mint' && n.filePath.endsWith('c.ts'));
    expect(mint).toBeDefined();
    const returns = cg.getOutgoingEdges(mint!.id).filter((e) => e.kind === 'returns');
    expect(returns.length).toBe(0);
  });

  it('uses JSDoc @returns when the signature has no return type', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'models.ts'),
      `export class Report {
  ok = true;
}
`
    );
    fs.writeFileSync(
      path.join(tempDir, 'build.js'),
      `/**
 * @returns {Report}
 */
export function buildReport() {
  return {};
}
`
    );

    cg = HomeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const report = cg.getNodesByKind('class').find((n) => n.name === 'Report');
    const build = cg.getNodesByKind('function').find((n) => n.name === 'buildReport');
    expect(report).toBeDefined();
    expect(build).toBeDefined();

    const returns = cg.getOutgoingEdges(build!.id).filter((e) => e.kind === 'returns');
    expect(returns.some((e) => e.target === report!.id)).toBe(true);
  });
});
