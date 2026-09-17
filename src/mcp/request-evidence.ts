import type { RequestContract, RequestTarget } from '../search/request-contract';

export interface RequestSource { filePath: string; start: number; source: string }
interface StringToken { start: number; end: number; value: string }
interface Lexed { code: string; strings: StringToken[]; pairs: Map<number, number>; valid: boolean }
export interface TargetEvidence {
  id: string; text: string; presence: RequestTarget['presence'];
  status: 'observed' | 'ambiguous' | 'not_observed' | 'requested_not_observed';
  locations: string[]; note: string;
}
export interface BehaviorEvidence {
  id: string; text: string; kind: string;
  status: 'binding_observed' | 'binding_not_observed' | 'unknown';
  locations: string[]; note: string;
}
export interface RequestEvidence {
  scope: 'returned_source_only'; runtimeVerified: false;
  targets: TargetEvidence[]; behaviors: BehaviorEvidence[];
}

/** Conservative lexical witness reader. It does not evaluate ArkTS or infer data flow.
 * Mask comments, strings, templates and regular expressions before reading structure.
 * Escaped/interpolated strings are deliberately not used as exact literal witnesses.
 */
function lex(source: string): Lexed {
  const chars = source.split(''); const strings: StringToken[] = [];
  const mask = (from: number, to: number) => { for (let n = from; n < to; n++) if (chars[n] !== '\n') chars[n] = ' '; };
  let valid = true;
  for (let i = 0; i < source.length;) {
    const c = source[i]; const start = i;
    if (c === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i); if (i < 0) i = source.length; mask(start, i); continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2); valid &&= end >= 0;
      i = end < 0 ? source.length : end + 2; mask(start, i); continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let escaped = false; i++;
      for (; i < source.length && source[i] !== c; i++) if (source[i] === '\\') { escaped = true; i++; }
      const closed = i < source.length; valid &&= closed; i = Math.min(source.length, i + 1);
      if (closed && !escaped && c !== '`') strings.push({ start, end: i, value: source.slice(start + 1, i - 1) });
      // Template substitutions require parsing; never infer behavior from such a unit.
      if (c === '`' && source.slice(start, i).includes('${')) valid = false;
      mask(start, i); continue;
    }
    if (c === '/') {
      const before = chars.slice(Math.max(0, i - 16), i).join('').trimEnd();
      if (!before || /[=(:,[!&|?{};]$|\b(?:return|throw|case)$/.test(before)) {
        i++; let inClass = false;
        for (; i < source.length; i++) {
          if (source[i] === '\\') { i++; continue; }
          if (source[i] === '[') inClass = true;
          if (source[i] === ']') inClass = false;
          if (source[i] === '/' && !inClass) break;
          if (source[i] === '\n') { valid = false; break; }
        }
        valid &&= i < source.length && source[i] === '/';
        i = Math.min(source.length, i + 1); while (/[a-z]/i.test(source[i] ?? '') && i < source.length) i++;
        mask(start, i); continue;
      }
    }
    i++;
  }
  const code = chars.join(''); const pairs = new Map<number, number>(); const stack: number[] = [];
  for (let i = 0; i < code.length; i++) {
    if ('([{'.includes(code[i]!)) stack.push(i);
    else if (')]}'.includes(code[i]!)) {
      const open = stack.pop();
      if (open === undefined || '([{'.indexOf(code[open]!) !== ')]}'.indexOf(code[i]!)) valid = false;
      else pairs.set(open, i);
    }
  }
  if (stack.length) valid = false;
  return { code, strings, pairs, valid };
}
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const identifierIn = (code: string, text: string): boolean =>
  /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(text)
  && new RegExp(`(?<![\\p{L}\\p{N}_$])${escape(text)}(?![\\p{L}\\p{N}_$])`, 'u').test(code);
const literalIn = (tokens: StringToken[], text: string): boolean => tokens.some(s => s.value === text);
function objectKind(code: string): RequestTarget['objectKind'] | undefined {
  if (/\bextends\s+FormExtensionAbility\b/.test(code)) return 'form';
  if (/\bnapi_(?:define_properties|module_register|create_function)\s*\(/.test(code)) return 'native';
  if (/@(?:Component|Entry)\b|\b(?:Button|Image|Text|Column|Row)\s*\(/.test(code)) return 'ui';
  return undefined;
}
function matches(target: RequestTarget, parsed: Lexed): boolean {
  // Paths alone are only hints. A target needs a code identifier or an exact string.
  const text = literalIn(parsed.strings, target.text) || (target.role !== 'literal' && identifierIn(parsed.code, target.text));
  return text && (!target.objectKind || objectKind(parsed.code) === target.objectKind);
}
interface Control { start: number; end: number; contentEnd: number; attributes: Array<{ name: string; start: number; end: number }>; complete: boolean }
function controls(parsed: Lexed): Control[] {
  if (!parsed.valid) return [];
  const { code, pairs } = parsed; const out: Control[] = [];
  const skip = (i: number) => { while (/\s/.test(code[i] ?? '') && i < code.length) i++; return i; };
  for (const m of code.matchAll(/\b(Button|Image|Text|SymbolGlyph|Toggle|Checkbox|Radio|TextInput|TextArea|Select|Search|Slider)\s*\(/g)) {
    const start = m.index!; if (/[\w$.]/.test(code[start - 1] ?? '')) continue;
    const open = start + m[0].lastIndexOf('('); const close = pairs.get(open); if (close === undefined) continue;
    let pos = skip(close + 1); let contentEnd = close + 1;
    if (code[pos] === '{') { const end = pairs.get(pos); if (end === undefined) continue; contentEnd = end + 1; pos = skip(end + 1); }
    const attributes: Control['attributes'] = [];
    while (code[pos] === '.') {
      const attribute = code.slice(pos).match(/^\.([A-Za-z_$][\w$]*)\s*\(/); if (!attribute) break;
      const argStart = pos + attribute[0].lastIndexOf('('); const argEnd = pairs.get(argStart); if (argEnd === undefined) break;
      attributes.push({ name: attribute[1]!, start: argStart + 1, end: argEnd }); pos = skip(argEnd + 1);
    }
    // Unexpected syntax leaves the result unknown, never a negative assertion.
    const complete = pos >= code.length || /[};]/.test(code[pos]!) || /^(?:[A-Z]\w*\s*\(|if\s*\(|else\b)/.test(code.slice(pos));
    out.push({ start, end: pos, contentEnd, attributes, complete });
  }
  return out;
}

/** Reuse one analysis per verified source unit; no disk reads or model calls. */
export function createRequestEvidenceInspector(contract: RequestContract) {
  const parsed = new Map<RequestSource, Lexed>();
  const parsedControls = new Map<Lexed, Control[]>();
  const read = (unit: RequestSource) => { let p = parsed.get(unit); if (!p) { p = lex(unit.source); parsed.set(unit, p); } return p; };
  const location = (unit: RequestSource, offset = 0) => `${unit.filePath}:${unit.start + unit.source.slice(0, offset).split('\n').length - 1}`;
  const score = (units: RequestSource[]): number => contract.targets.reduce((total, target) => {
    if (!units.some(u => matches(target, read(u)))) return total;
    return total + (target.presence === 'requested' ? 1 : target.role === 'page' ? 6 : 3);
  }, 0);
  const inspect = (units: RequestSource[]): RequestEvidence => ({
    scope: 'returned_source_only', runtimeVerified: false,
    targets: contract.targets.map(target => {
      const hits = units.filter(u => matches(target, read(u)));
      const distinctFiles = new Set(hits.map(u => u.filePath));
      return { id: target.id, text: target.text, presence: target.presence,
        status: distinctFiles.size > 1 ? 'ambiguous' : hits.length ? 'observed' : target.presence === 'requested' ? 'requested_not_observed' : 'not_observed',
        locations: hits.slice(0, 3).map(u => location(u)),
        note: hits.length ? 'Exact source witness; page ownership and full requirement still need verification.'
          : target.presence === 'requested' ? 'Requested output may not exist yet; absence is not a retrieval failure.'
            : 'No verified witness in returned declarations; inspect the specified page/object or resource binding.' };
    }),
    behaviors: contract.obligations.map(obligation => {
      const base = { id: obligation.id, text: obligation.text, kind: obligation.kind, locations: [] as string[] };
      const target = contract.targets.find(t => t.id === obligation.targetId);
      if (obligation.kind !== 'enabled' || !target) return { ...base, status: 'unknown', note: 'Locate the specific control and verify this behavior; no static checker available for this obligation.' };
      const pages = contract.targets.filter(t => t.role === 'page' && t.presence === 'existing');
      const pageSources = new Set(units.filter(u => pages.some(t => matches(t, read(u)))));
      if (pages.length && !pageSources.size) return { ...base, status: 'unknown', note: 'Requested page has no returned source witness; locate page ownership before checking the control.' };
      const found: Array<{ unit: RequestSource; control: Control; parsed: Lexed }> = [];
      for (const unit of units) {
        if (pages.length && !pageSources.has(unit)) continue;
        const p = read(unit);
        let list = parsedControls.get(p); if (!list) { list = controls(p); parsedControls.set(p, list); }
        for (const control of list) {
          // Match the declaration content, never strings inside onClick or other attributes.
          const tokens = p.strings.filter(s => s.start >= control.start && s.end <= control.contentEnd);
          const code = p.code.slice(control.start, control.contentEnd);
          if ((literalIn(tokens, target.text) || (target.role === 'symbol' && identifierIn(code, target.text)))
            && (!target.objectKind || objectKind(p.code) === target.objectKind)) found.push({ unit, control, parsed: p });
        }
      }
      // Nested Button { Text('label') } belongs to the outer interactive Button.
      const candidates = found.filter(f => !found.some(parent => parent !== f && parent.unit === f.unit
        && parent.control.start < f.control.start && parent.control.contentEnd > f.control.contentEnd));
      if (candidates.length !== 1) return { ...base, status: 'unknown', note: candidates.length ? 'Several matching controls; disambiguate by page/owner before checking behavior.' : 'Target control absent or unsupported syntax/resource indirection; inspect its complete declaration.' };
      const { unit, control, parsed: p } = candidates[0]!;
      const bindings = control.attributes.filter(a => a.name === 'enabled');
      const locations = [location(unit, control.start)];
      if (!control.complete || bindings.length > 1) return { ...base, locations, status: 'unknown', note: 'Incomplete or repeated enabled modifiers; inspect effective control attributes.' };
      if (!bindings.length) return { ...base, locations, status: 'binding_not_observed', note: 'No direct .enabled(...) on this returned control. Images and click guards do not establish enabled state; inspect inherited enablement or add the required binding.' };
      const expression = p.code.slice(bindings[0]!.start, bindings[0]!.end).trim();
      if (!expression || /^(?:true|false)$/.test(expression)) return { ...base, locations, status: 'unknown', note: 'Only a constant or unsupported enabled expression is visible; conditional behavior remains unverified.' };
      return { ...base, locations, status: 'binding_observed', note: 'Direct .enabled(expression) exists on this control. Condition correctness, state updates and runtime behavior remain unverified.' };
    }),
  });
  return { score, inspect };
}

export function renderRequestEvidence(evidence: RequestEvidence, targets: boolean, behaviors: boolean): string[] {
  const safe = (s: string) => s.replace(/[`\r\n]/g, ' ');
  const rows = [
    ...(targets ? evidence.targets.map(t => `- Target ${t.id} “${safe(t.text)}”: ${t.status}. ${t.locations.map(safe).join(', ')} ${t.note}`) : []),
    ...(behaviors ? evidence.behaviors.map(b => `- Behavior ${b.id} “${safe(b.text)}”: ${b.status}. ${b.locations.map(safe).join(', ')} ${b.note}`) : []),
  ];
  return rows.length ? ['**Request evidence — source coverage is not behavioral completion**', ...rows] : [];
}
