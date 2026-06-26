/**
 * Spec file discovery and metadata extraction.
 *
 * Replaces `commit4spec/reverse_engineer/spec_extractor.py`.
 * Discovers spec files in a storage directory and extracts structured
 * metadata (title, subtitles, commit hash from commit-info.md).
 *
 * @module spec/mining/spec-extractor
 */

import * as fs from 'fs';
import * as path from 'path';
import { SpecConfig, SpecDiscoveryConfig, DEFAULT_CONFIG } from '../config';
import { readFileContent, parseCommitInfoMd } from '../utils';
import { logDebug, logWarn } from '../../errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpecMetadata {
  specId: string;
  title: string;
  subtitles: string[];
  commitHash: string | null;
  filePath: string;
  type: 'directory' | 'flat-file';
}

export interface SupplementaryDoc {
  path: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.*)/;

// ---------------------------------------------------------------------------
// extractMarkdownHeadings
// ---------------------------------------------------------------------------

/**
 * Parse ATX headings from markdown content and build breadcrumb-path strings
 * with content previews.
 *
 * Algorithm (ported from `spec_extractor.py:50-88`):
 *
 * 1. Find all `#` … `######` headings (ATX-style) and their line positions.
 * 2. Walk through headings, maintaining a breadcrumb stack — pop until the
 *    stack is shorter than the current heading's level, then push the new
 *    heading text.
 * 3. For each heading, collect the "direct content" lines — non-heading,
 *    non-empty lines between this heading and the next heading of equal or
 *    higher level (or EOF).
 * 4. Skip headings that have sub-headings but no direct content.
 * 5. Build a display string: `breadcrumb_path - first_direct_content_line`.
 * 6. Strip `SPEC` suffix from level-1 (root) breadcrumb parts.
 * 7. Truncate the preview to `maxContentLen` characters, appending `…`
 *    when truncated.
 *
 * @param content       - Raw markdown string.
 * @param maxContentLen - Max characters for the content preview (default 200).
 * @returns Array of formatted heading strings.
 */
export function extractMarkdownHeadings(
  content: string,
  maxContentLen: number = 200,
): string[] {
  const lines = content.split('\n');

  // First pass: locate all headings and their metadata.
  interface HeadingEntry {
    lineIndex: number;
    level: number;
    text: string;
  }

  const headings: HeadingEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = HEADING_RE.exec(lines[i]!);
    if (!match) continue;
    const text = match[2]!.trim();
    if (!text) continue;
    headings.push({
      lineIndex: i,
      level: match[1]!.length,
      text,
    });
  }

  // Second pass: build breadcrumb and collect direct content.
  const breadcrumb: string[] = [];
  const result: string[] = [];

  for (let hi = 0; hi < headings.length; hi++) {
    const h = headings[hi]!;

    // Adjust breadcrumb: pop until we're at the right depth.
    while (breadcrumb.length >= h.level) {
      breadcrumb.pop();
    }
    breadcrumb.push(h.text);

    // Determine the end line of this heading's content section.
    // The section ends at the next heading of equal or higher level (or EOF).
    let endLine = lines.length;
    for (let hj = hi + 1; hj < headings.length; hj++) {
      const nextH = headings[hj]!;
      if (nextH.level <= h.level) {
        endLine = nextH.lineIndex;
        break;
      }
    }

    // Collect direct content: non-heading, non-empty lines within this section.
    const directLines: string[] = [];
    let hasSubHeadings = false;

    for (let li = h.lineIndex + 1; li < endLine; li++) {
      const line = lines[li]!.trim();
      if (!line) continue;

      if (HEADING_RE.test(line)) {
        hasSubHeadings = true;
        continue;
      }

      directLines.push(line);
    }

    // Skip headings that only contain sub-headings (no direct text).
    if (hasSubHeadings && directLines.length === 0) {
      continue;
    }

    // Build the display path.
    let display = breadcrumb.join(' → ');

    // Strip trailing SPEC from level-1 (root) headings.
    if (breadcrumb.length === 1) {
      display = display.replace(/\s*SPEC\s*$/i, '');
    }

    // Append content preview (first direct line, truncated).
    if (directLines.length > 0) {
      let preview: string = directLines[0]!;
      if (preview.length > maxContentLen) {
        preview = preview.slice(0, maxContentLen) + '…';
      }
      display += ' - ' + preview;
    }

    result.push(display);
  }

  return result;
}

// ---------------------------------------------------------------------------
// _findPrimaryDoc
// ---------------------------------------------------------------------------

/**
 * Find the primary spec document by trying each candidate name.
 *
 * Replaces the `{spec_dir}` placeholder in each candidate with `specDirName`,
 * then checks whether the resolved file exists in `specDirPath`.  Returns the
 * first match as `[resolvedName, absolutePath]`, or `null` when no candidate
 * matches.
 *
 * Ported from `spec_extractor.py:94-114`.
 */
function _findPrimaryDoc(
  specDirPath: string,
  specDirName: string,
  candidates: string[],
): [string, string] | null {
  for (const candidate of candidates) {
    const resolved = candidate.replace(/\{spec_dir\}/g, specDirName);
    const absPath = path.join(specDirPath, resolved);
    if (fs.existsSync(absPath)) {
      return [resolved, absPath];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Glob helper
// ---------------------------------------------------------------------------

/**
 * Simple glob-to-regex conversion for supplementary document matching.
 *
 * Only handles `*` (any non-separator characters) and literal text.
 * Does not support `**`, `?`, or character classes — sufficient for
 * patterns like `"*.md"` or `"changelog-*.md"`.
 */
function globToRegex(glob: string): RegExp {
  // Escape regex-special characters except *
  let pattern = '';
  for (const ch of glob) {
    if (ch === '*') {
      pattern += '[^/]*';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      pattern += '\\' + ch;
    } else {
      pattern += ch;
    }
  }
  return new RegExp('^' + pattern + '$');
}

// ---------------------------------------------------------------------------
// _buildMetadata
// ---------------------------------------------------------------------------

/**
 * Build `SpecMetadata` from raw spec content and supplementary documents.
 *
 * Ported from `spec_extractor.py:120-171`.
 *
 * 1. Extract a title from the first `# ` heading (stripping a trailing
 *    `SPEC` suffix); fallback to `specId`.
 * 2. Collect subtitles via `extractMarkdownHeadings`.
 * 3. Discover supplementary `.md` files in `specDirPath` that match
 *    `config.supplementaryGlobs` (excluding the primary doc) and merge
 *    their headings into the subtitle list.
 * 4. Resolve a commit hash from `commit-info.md` content in `specDirPath`
 *    (using `config.commitInfoCandidates`).
 */
function _buildMetadata(
  specId: string,
  content: string,
  filePath: string,
  specDirPath: string,
  config: SpecDiscoveryConfig,
): SpecMetadata {
  // ---- title ----
  let title = specId;
  const firstH1Match = content.match(/^#\s+(.*)/m);
  if (firstH1Match && firstH1Match[1]) {
    title = firstH1Match[1].trim().replace(/\s*SPEC\s*$/i, '');
    if (!title) {
      title = specId;
    }
  }

  // ---- subtitles from primary doc ----
  const subtitles = extractMarkdownHeadings(content);

  // ---- supplementary docs ----
  // Find the primary doc's filename so we can skip it.
  const primaryDocName = path.basename(filePath);

  let dirEntries: fs.Dirent[];
  try {
    dirEntries = fs.readdirSync(specDirPath, { withFileTypes: true });
  } catch {
    dirEntries = [];
  }

  const globRegexes = config.supplementaryGlobs.map((g) => globToRegex(g));

  for (const entry of dirEntries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    if (entry.name === primaryDocName) continue;

    // Check if the file name matches any supplementary glob.
    const matchesGlob = globRegexes.some((re) => re.test(entry.name));
    if (!matchesGlob) continue;

    const suppPath = path.join(specDirPath, entry.name);
    const suppContent = readFileContent(suppPath);
    if (suppContent === null) continue;

    const suppHeadings = extractMarkdownHeadings(suppContent);
    for (const heading of suppHeadings) {
      subtitles.push(heading);
    }
  }

  // ---- commit hash ----
  let commitHash: string | null = null;
  for (const candidate of config.commitInfoCandidates) {
    const ciPath = path.join(specDirPath, candidate);
    const ciContent = readFileContent(ciPath);
    if (ciContent !== null) {
      commitHash = parseCommitInfoMd(ciContent);
      break;
    }
  }

  logDebug('Built spec metadata', { specId, title, subtitleCount: subtitles.length, commitHash });

  return {
    specId,
    title,
    subtitles,
    commitHash,
    filePath,
    type: 'directory',
  };
}

// ---------------------------------------------------------------------------
// extractSpecMetadata (public)
// ---------------------------------------------------------------------------

/**
 * Discover and extract metadata for a single spec, given its storage location
 * and directory name.
 *
 * Ported from `spec_extractor.py:177-237`.
 *
 * Two discovery branches are attempted in order:
 *
 * - **Flat-file**: checks `{specStoragePath}/{specDirName}.md`.  If it exists,
 *   reads it and produces metadata with `type: 'flat-file'`.
 * - **Directory**: checks `{specStoragePath}/{specDirName}/`.  If it exists,
 *   searches for a primary document using `config.discovery.primaryDocCandidates`,
 *   reads it, and produces metadata with `type: 'directory'`.
 *
 * Returns `null` when neither branch yields a readable spec.
 *
 * @param specStoragePath - Root directory where specs are stored.
 * @param specDirName     - Name of the spec (e.g. "spec03", "auth-module").
 * @param config          - Optional full `SpecConfig`; falls back to defaults
 *                          when omitted (discovery config resolved at call site).
 */
export function extractSpecMetadata(
  specStoragePath: string,
  specDirName: string,
  config?: SpecConfig,
): SpecMetadata | null {
  // Resolve discovery config — use provided config or the built-in defaults.
  const discoveryConfig: SpecDiscoveryConfig = config?.discovery ?? DEFAULT_CONFIG.discovery;

  // Branch A: flat-file
  const flatFilePath = path.join(specStoragePath, `${specDirName}.md`);
  if (fs.existsSync(flatFilePath) && fs.statSync(flatFilePath).isFile()) {
    const content = readFileContent(flatFilePath);
    if (content !== null) {
      logDebug('Discovered flat-file spec', { specDirName, path: flatFilePath });

      // Build metadata manually for flat-file (no supplementary docs or
      // commit-info in the same directory — those live alongside the flat
      // file's parent, which is specStoragePath itself).
      let title = specDirName;
      const firstH1Match = content.match(/^#\s+(.*)/m);
      if (firstH1Match && firstH1Match[1]) {
        title = firstH1Match[1].trim().replace(/\s*SPEC\s*$/i, '');
        if (!title) title = specDirName;
      }

      const subtitles = extractMarkdownHeadings(content);

      // Attempt to read commit-info from specStoragePath for supplementary
      // context (though flat-file specs rarely have one).
      let commitHash: string | null = null;
      for (const candidate of discoveryConfig.commitInfoCandidates) {
        const ciPath = path.join(specStoragePath, candidate);
        const ciContent = readFileContent(ciPath);
        if (ciContent !== null) {
          commitHash = parseCommitInfoMd(ciContent);
          break;
        }
      }

      return {
        specId: specDirName,
        title,
        subtitles,
        commitHash,
        filePath: flatFilePath,
        type: 'flat-file',
      };
    }
  }

  // Branch B: directory
  const specDirPath = path.join(specStoragePath, specDirName);
  if (fs.existsSync(specDirPath) && fs.statSync(specDirPath).isDirectory()) {
    const primary = _findPrimaryDoc(
      specDirPath,
      specDirName,
      discoveryConfig.primaryDocCandidates,
    );

    if (primary) {
      const [, primaryAbsPath] = primary;
      const content = readFileContent(primaryAbsPath);
      if (content !== null) {
        logDebug('Discovered directory spec', { specDirName, primaryDoc: primaryAbsPath });

        const meta = _buildMetadata(
          specDirName,
          content,
          primaryAbsPath,
          specDirPath,
          discoveryConfig,
        );
        return { ...meta, type: 'directory' };
      }
    }

    // Directory exists but no primary doc was found or it was unreadable.
    logWarn('Spec directory exists but no primary doc found', {
      specDirName,
      specDirPath,
      candidates: discoveryConfig.primaryDocCandidates,
    });
  }

  return null;
}
