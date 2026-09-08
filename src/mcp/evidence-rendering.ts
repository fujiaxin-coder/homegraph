import type { Node } from '../types';

/** Multiple parser roles for one source declaration are not overloads. */
export function canonicalSourceDeclarations(nodes: Node[]): Node[] {
  const out: Node[] = [];
  const roles = new Map<string, number>();
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) continue;
    ids.add(node.id);
    if (node.kind !== 'struct' && node.kind !== 'component') { out.push(node); continue; }
    const key = `${node.filePath}:${node.startLine}:${node.name}`;
    const prior = roles.get(key);
    if (prior === undefined) { roles.set(key, out.length); out.push(node); }
    else if (node.kind === 'component') out[prior] = node;
  }
  return out;
}

/** Guidance describes retrieval; it must never close the host's coding task.
 * Source fences are byte-preserved, including strings that resemble guidance.
 */
export function neutralRetrievalGuidance(text: string): string {
  let fence = '';
  return text.split('\n').map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1]![0]!;
      else if (marker[1]![0] === fence) fence = '';
      return line;
    }
    if (fence) return line;
    if (/^>\s*\*\*Explore complete/i.test(line)) {
      return '> Retrieval returned the evidence shown above. Check missing requirements, continue the requested edits, and verify the resulting code.';
    }
    if (/^>/.test(line) && /treat as already Read|treat it as already Read/i.test(line)) {
      return '> The displayed source ranges are available as evidence. Inspect omitted ranges or changed files when needed; avoid repeating unchanged ranges.';
    }
    return line
      .replace(/\*{0,2}ANSWER NOW\*{0,2}/g, 'use the evidence shown')
      .replace(/Flow \+ Source above are authoritative for this query\./g, 'Source coverage is limited to the displayed ranges.')
      .replace(/Do \*\*not\*\* grep\/read\/`homegraph_node`\/`homegraph_search`[^.]*\./gi, 'Inspect missing evidence as needed.')
      .replace(/do\s+\*{0,2}not\*{0,2}\s+(?:re-)?(?:grep|read|glob)(?:\/[^.;]+)?[^.;]*[.;]/gi, 'Avoid duplicate reads of unchanged ranges;');
  }).join('\n');
}

/** Preserve complete lines at a shared output limit; never forge a full body. */
export function trimEvidenceAtLine(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const note = '\n[Partial source: shared output budget reached; omitted ranges remain available for a focused lookup.]';
  const cut = text.slice(0, Math.max(0, limit - note.length - 5));
  const boundary = cut.lastIndexOf('\n');
  let kept = boundary >= 0 ? cut.slice(0, boundary) : '';
  if ((kept.match(/^\s*```/gm)?.length ?? 0) % 2) kept += '\n```';
  return kept + note;
}
