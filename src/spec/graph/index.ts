/**
 * Spec Graph Layer — Barrel Export
 *
 * Composition-layer queries over the Spec→Commit→CodeFragment knowledge
 * graph. Consumers can `import { ... } from '../spec/graph'`.
 */

export {
  getSpecContext,
  findSpecsByFragmentPath,
  findSpecsByFilePath,
  FindSpecsByFilePathResult,
  getSpecStats,
  searchAndGetContext,
  findSpecsByCodeSymbol,
  CodeEntityInfo,
  CodeEntitySpecMatch,
  FindSpecsByCodeSymbolResult,
} from './queries';
