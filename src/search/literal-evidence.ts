/** Bounded, project-local source witnesses for verbatim UI text. */
import * as fs from 'fs';
import * as path from 'path';
import ignore from 'ignore';
import { parse } from 'jsonc-parser';
import { validatePathWithinRoot } from '../utils';

export interface LiteralEvidenceHit {
  kind: 'source_literal' | 'resource_reference';
  filePath: string;
  line: number;
  startLine: number;
  endLine: number;
  text: string;
  literal: string;
  resource?: { filePath: string; line: number; key: string; value: string };
}

export interface LiteralEvidenceResult {
  hits: LiteralEvidenceHit[];
  stats: { filesVisited: number; filesRead: number; bytesRead: number; durationMs: number };
  truncated: boolean;
  limitsHit: string[];
}

export interface LiteralEvidenceOptions {
  literalTexts: string[];
  /** Indexed paths are prioritized, but resources and unindexed UI files are also discoverable. */
  files?: string[];
  maxFiles?: number;
  maxBytes?: number;
  maxFileBytes?: number;
  maxDurationMs?: number;
  maxHits?: number;
}

const SOURCE_EXTENSIONS = new Set([
  '.ets', '.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte', '.cpp', '.cc', '.c',
  '.h', '.hpp', '.java', '.kt', '.swift', '.dart', '.html', '.xml', '.qml',
]);
const SKIP_DIRS = new Set(['node_modules', 'oh_modules', '.git', '.homegraph', '.hvigor', 'dist', 'build', 'coverage']);
const resourceFile = (file: string): boolean => /(?:^|\/)resources\/[^\n]*\/element\/string\.json$/i.test(file);
const allowedFile = (file: string): boolean => resourceFile(file)
  || (SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()) && !/\.d\.ts$|\.min\.js$/i.test(file));

/** Strings are data, never regexes, paths, or commands. */
export function normalizeLiteralTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, 8).filter((x): x is string => typeof x === 'string')
    .map(x => x.trim()).filter(x => x.length >= 2 && x.length <= 160 && !/[\u0000-\u001f\u007f]/.test(x)))];
}

/**
 * Follow only resource-value -> exact $r('app.string.key') source references.
 * A text match is an observed source location, not proof that the whole flow is resolved.
 */
export function findLiteralEvidence(projectRoot: string, options: LiteralEvidenceOptions): LiteralEvidenceResult {
  const started = Date.now();
  const result: LiteralEvidenceResult = {
    hits: [], stats: { filesVisited: 0, filesRead: 0, bytesRead: 0, durationMs: 0 }, truncated: false, limitsHit: [],
  };
  const texts = normalizeLiteralTexts(options.literalTexts);
  if (!texts.length) return result;
  const bound = (value: number | undefined, fallback: number, ceiling: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(ceiling, Math.floor(value))) : fallback;
  const maxFiles = bound(options.maxFiles, 2000, 4000);
  const maxBytes = bound(options.maxBytes, 12 * 1024 * 1024, 24 * 1024 * 1024);
  const maxFileBytes = bound(options.maxFileBytes, 512 * 1024, 1024 * 1024);
  const maxDurationMs = bound(options.maxDurationMs, 600, 1500);
  const maxHits = bound(options.maxHits, 12, 24);
  const mark = (reason: string): void => {
    result.truncated = true;
    if (!result.limitsHit.includes(reason)) result.limitsHit.push(reason);
  };
  const timedOut = (): boolean => {
    if (Date.now() - started < maxDurationMs) return false;
    mark('time'); return true;
  };
  const root = path.resolve(projectRoot);
  const rules = new Map<string, ReturnType<typeof ignore>>();
  const loadIgnore = (directory: string): void => {
    const candidate = validatePathWithinRoot(root, path.join(directory, '.gitignore'));
    if (!candidate) return;
    try {
      if (fs.lstatSync(candidate).isFile() && fs.statSync(candidate).size <= 64 * 1024) {
        rules.set(directory, ignore().add(fs.readFileSync(candidate, 'utf8')));
      }
    } catch { /* A missing or unreadable ignore file is ordinary. */ }
  };
  const ignored = (relative: string, directory = false): boolean => {
    if (relative.split('/').some(part => SKIP_DIRS.has(part) || part.startsWith('.'))) return true;
    for (const [base, matcher] of rules) {
      const rel = path.relative(base, path.join(root, relative)).split(path.sep).join('/');
      if (rel && !rel.startsWith('../') && matcher.ignores(rel + (directory ? '/' : ''))) return true;
    }
    return false;
  };
  loadIgnore(root);
  const candidates = new Set<string>();
  // A deterministic bounded walk also discovers resource files excluded by AST indexing.
  const directories = [root];
  let entriesVisited = 0;
  for (let cursor = 0; cursor < directories.length && !timedOut(); cursor++) {
    const directory = directories[cursor]!;
    loadIgnore(directory);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch { continue; }
    for (const entry of entries) {
      if (++entriesVisited > maxFiles * 4) { mark('entries'); break; }
      if (timedOut()) break;
      const relative = path.relative(root, path.join(directory, entry.name)).split(path.sep).join('/');
      if (entry.isSymbolicLink() || ignored(relative, entry.isDirectory())) continue;
      if (entry.isDirectory()) directories.push(path.join(directory, entry.name));
      else if (entry.isFile() && allowedFile(relative)) candidates.add(relative);
    }
    if (entriesVisited > maxFiles * 4) break;
  }
  for (const file of (options.files ?? []).slice(0, maxFiles * 2)) {
    const relative = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
    if (!relative.startsWith('../') && !ignored(relative) && allowedFile(relative)) candidates.add(relative);
  }
  // UI/managed source is a separate entry modality; native graph density cannot starve it.
  const priority = (file: string): number => resourceFile(file) ? 0 : /\.(ets|tsx|jsx|vue|svelte)$/i.test(file) ? 1 : 2;
  const sorted = [...candidates].sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
  const resources: Array<{ literal: string; filePath: string; line: number; key: string; value: string }> = [];
  const read = (relative: string): string | undefined => {
    if (timedOut()) return undefined;
    if (result.stats.filesVisited >= maxFiles) { mark('files'); return undefined; }
    result.stats.filesVisited++;
    const absolute = validatePathWithinRoot(root, relative);
    if (!absolute) return undefined;
    try {
      const st = fs.lstatSync(absolute);
      if (!st.isFile()) return undefined;
      if (st.size > maxFileBytes) { mark('file_bytes'); return undefined; }
      if (result.stats.bytesRead + st.size > maxBytes) { mark('bytes'); return undefined; }
      const data = fs.readFileSync(absolute, 'utf8');
      result.stats.filesRead++;
      result.stats.bytesRead += Buffer.byteLength(data);
      return data.includes('\0') ? undefined : data;
    } catch { return undefined; }
  };
  const append = (file: string, content: string, offset: number, literal: string,
    resource?: LiteralEvidenceHit['resource']): void => {
    const line = content.slice(0, offset).split('\n').length;
    if (result.hits.some(hit => hit.filePath === file && hit.line === line)) return;
    if (result.hits.length >= maxHits) { mark('hits'); return; }
    const lines = content.split('\n');
    // Grow a contiguous range around the matching line. Never spend the whole
    // snippet on preceding boilerplate and silently omit the witness itself.
    let startLine = line;
    let endLine = line;
    let chars = (lines[line - 1]?.length ?? 0) + 1;
    if (chars > 2400) { mark('snippet'); return; }
    while (endLine < Math.min(lines.length, line + 12)
      && chars + (lines[endLine]?.length ?? 0) + 1 <= 2400) {
      chars += (lines[endLine]?.length ?? 0) + 1;
      endLine++;
    }
    while (startLine > Math.max(1, line - 8)
      && chars + (lines[startLine - 2]?.length ?? 0) + 1 <= 2400) {
      chars += (lines[startLine - 2]?.length ?? 0) + 1;
      startLine--;
    }
    if (startLine > Math.max(1, line - 8) || endLine < Math.min(lines.length, line + 12)) mark('snippet');
    const emitted = lines.slice(startLine - 1, endLine);
    result.hits.push({ kind: resource ? 'resource_reference' : 'source_literal', filePath: file,
      line, startLine, endLine: startLine + emitted.length - 1, text: emitted.join('\n'), literal,
      ...(resource ? { resource } : {}) });
  };
  for (const file of sorted) {
    if (timedOut() || result.stats.filesVisited >= maxFiles || result.stats.bytesRead >= maxBytes) {
      if (result.stats.filesVisited >= maxFiles) mark('files');
      if (result.stats.bytesRead >= maxBytes) mark('bytes');
      break;
    }
    const content = read(file);
    if (content === undefined) continue;
    if (resourceFile(file)) {
      const data: unknown = parse(content, undefined, { allowTrailingComma: true });
      let visited = 0;
      const visit = (value: unknown, depth: number): void => {
        if (++visited > 10000 || depth > 12 || timedOut() || !value || typeof value !== 'object') return;
        if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
        const entry = value as Record<string, unknown>;
        if (typeof entry.name === 'string' && typeof entry.value === 'string' && /^[A-Za-z_][\w]*$/.test(entry.name)) {
          for (const literal of texts) {
            if (entry.value.toLocaleLowerCase().includes(literal.toLocaleLowerCase()) && resources.length < 64) {
              resources.push({ literal, filePath: file, line: content.slice(0, content.indexOf(JSON.stringify(entry.name))).split('\n').length,
                key: entry.name, value: entry.value.slice(0, 200) });
            }
          }
        }
        for (const child of Object.values(entry)) visit(child, depth + 1);
      };
      visit(data, 0);
      continue;
    }
    for (const literal of texts) {
      // Exact text witnesses do not reinterpret regex metacharacters or tokenize labels.
      const offset = content.toLocaleLowerCase().indexOf(literal.toLocaleLowerCase());
      if (offset >= 0) append(file, content, offset, literal);
    }
    const reference = /\$r\s*\(\s*(['"])(?:app|[A-Za-z_]\w*)\.string\.([A-Za-z_]\w*)\1\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = reference.exec(content)) !== null) {
      for (const resource of resources) {
        if (resource.key === match[2]) append(file, content, match.index, resource.literal, resource);
      }
    }
  }
  result.stats.durationMs = Date.now() - started;
  return result;
}
