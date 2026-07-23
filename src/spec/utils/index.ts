/**
 * Spec utility functions — barrel export.
 *
 * Replaces `file_utils.py`, `meta.py`, and `truncate.py` from Python
 * Commit4Spec. Consumers can keep importing from `../spec/utils`.
 *
 * @module spec/utils
 */

export {
  SPEC_DATA_DIR,
  SpecEntry,
  readFileContent,
  writeFileContent,
  discoverSpecs,
  resolveDbPath,
} from './fs';

export {
  SpecMeta,
  readMeta,
  writeMeta,
} from './meta';

export {
  BudgetProfile,
  truncateCodeDiff,
  truncateText,
  truncateSubtitles,
  computeBudgetProfile,
} from './truncate';
