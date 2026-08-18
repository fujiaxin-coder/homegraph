/**
 * Session-level explore repeat / partial guidance (generic).
 *
 * Stops agents from treating `homegraph_explore` as an iterative keyword
 * searcher: overlapping queries after a successful explore get a short refuse
 * instead of another multi-kB payload. Partial/busy replies carry concrete
 * retry anchors extracted from the query — never an empty 242-char shell.
 *
 * Failure fuse (post A/B): hard-cap explores per session, require tight
 * single-Type follow-ups after 2 calls, and bind Partial → named Next anchor.
 *
 * Shape-driven only — no product nouns.
 */

import { mechanismDomainPathTokens } from '../search/query-utils';
import type { ExploreCallRecord, ExploreProjectState } from './explore-session-state';

/** Tokens that do not distinguish one explore bag from another. */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'from',
  'how', 'what', 'which', 'where', 'when', 'why', 'is', 'are', 'was', 'were',
  'do', 'does', 'did', 'be', 'been', 'this', 'that', 'these', 'those',
  '项目', '工程', '代码', '功能', '如何', '怎么', '什么', '哪些', '哪个',
  '实现', '相关', '关于', '进行', '使用', '调用', '涉及', '是否', '有没有',
  'please', 'show', 'find', 'list', 'explain', 'describe', 'implement',
  'code', 'file', 'files', 'function', 'functions', 'method', 'methods',
  'class', 'module', 'project', 'repo', 'repository',
]);

/**
 * Significant tokens for bag-overlap (ASCII identifiers + CJK runs ≥2).
 */
export function exploreQueryTokens(query: string): Set<string> {
  const out = new Set<string>();
  const q = query.trim().toLowerCase();
  if (!q) return out;
  for (const m of q.matchAll(/[a-z][a-z0-9_./:@-]{2,}/g)) {
    const t = m[0]!.replace(/^[@/]+|[/]+$/g, '');
    if (t.length >= 3 && !STOP.has(t)) out.add(t);
  }
  for (const m of q.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const t = m[0]!;
    if (!STOP.has(t)) out.add(t);
  }
  return out;
}

/** Jaccard overlap in [0, 1]. */
export function queryTokenJaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Bag similarity: max(Jaccard, one-sided containment).
 * Paraphrases often keep the same English seeds while swapping CJK filler —
 * pure Jaccard under-fires on those; containment catches them.
 */
export function queryTokenOverlapScore(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  if (inter === 0) return 0;
  const jaccard = inter / (a.size + b.size - inter);
  const containment = Math.max(inter / a.size, inter / b.size);
  return Math.max(jaccard, containment);
}

/**
 * Concrete anchors an agent can put in a tighter follow-up explore.
 * Pure string extraction — no DB.
 */
export function extractRetryAnchorsFromQuery(query: string): string[] {
  const anchors: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const t = s.trim();
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    anchors.push(t);
  };

  for (const m of query.matchAll(/@kit\.[A-Za-z][\w.]*/g)) add(m[0]!);
  for (const m of query.matchAll(/@ohos\.[A-Za-z][\w.]*/g)) add(m[0]!);
  for (const m of query.matchAll(/\b[A-Za-z_][\w]*\.(?:ets|ts|tsx|js|jsx|cpp|h|hpp|c)\b/g)) add(m[0]!);
  for (const m of query.matchAll(/\b([A-Z][A-Za-z0-9]*(?:[A-Z][a-z0-9]+)+)\b/g)) add(m[1]!);
  for (const m of query.matchAll(/\b([A-Za-z_][\w]*)::([A-Za-z_][\w]*)\b/g)) add(`${m[1]}::${m[2]}`);
  for (const m of query.matchAll(/\b([A-Z][A-Za-z0-9]+)\.([a-z][A-Za-z0-9]*)\b/g)) {
    add(`${m[1]}.${m[2]}`);
  }

  return anchors.slice(0, 8);
}

/** Anchors present in `query` that never appeared in any prior query string. */
export function novelAnchorsVsPriors(query: string, priors: ReadonlyArray<ExploreCallRecord>): string[] {
  const priorBlob = priors.map((c) => c.query).join('\n').toLowerCase();
  return extractRetryAnchorsFromQuery(query).filter((a) => !priorBlob.includes(a.toLowerCase()));
}

/**
 * Follow-up after the soft budget must be a tight Type/file bag — not another
 * NL paraphrase that merely picks a Type name from a prior inventory.
 */
export function isTightExploreFollowUp(query: string): boolean {
  const anchors = extractRetryAnchorsFromQuery(query);
  if (anchors.length < 1 || anchors.length > 2) return false;
  const tokens = exploreQueryTokens(query);
  return tokens.size <= anchors.length + 3;
}

/** Pull `Next anchor` name from a Partial response body. */
export function extractNextAnchorFromText(text: string): string | undefined {
  const m =
    text.match(/\*\*Next anchor:\*\*[^*\n`]*`([^`]+)`/i)
    || text.match(/Next anchor:\s*`([^`]+)`/i);
  const raw = m?.[1]?.trim();
  if (!raw) return undefined;
  // Prefer the leading identifier if the caption includes kind/path.
  const id = raw.match(/^[A-Za-z_@][\w./:@-]*/)?.[0] ?? raw.split(/\s+/)[0];
  return id?.slice(0, 120);
}

export function inferExplorePartialMeta(text: string): { partial: boolean; nextAnchor?: string } {
  // Soft-close / coarse-locate ANSWER must win over a leftover Partial header
  // (same response used to emit both — session fuse must treat it as closed).
  const closedAnswer =
    /\*\*ANSWER NOW\*\*|Mechanism explore complete — \*\*ANSWER NOW\*\*|Explore complete — ANSWER NOW|Coarse locate — ANSWER|Coarse locate complete/i
      .test(text);
  const partial =
    /\*\*Partial locator\*\*|Partial locator|⚠️ \*\*Partial result\*\*|\*\*Partial result\*\*/i.test(text)
    && !closedAnswer;
  return {
    partial,
    nextAnchor: partial ? extractNextAnchorFromText(text) : undefined,
  };
}

export interface ExploreRepeatDecision {
  refuse: boolean;
  /** Matched prior call when refusing for overlap. */
  matched?: ExploreCallRecord;
  reason: 'overlap' | 'call-budget' | 'hard-cap' | 'next-anchor' | 'ok';
}

const OVERLAP_THRESHOLD = 0.45;
/**
 * Absolute explore fuse per session/project (counted responses ≥400 chars).
 * After this many, refuse — answer from prior Anchors or ONE narrow Grep.
 */
const MAX_EXPLORES = 2;

/**
 * After a counted Partial explore, allow this many depth tools
 * (`homegraph_node` / callers / callees) before refusing — stops Partial→node×N
 * compensation without per-question tuning.
 */
const MAX_DEPTH_AFTER_PARTIAL = 1;

function isCountedCall(call: ExploreCallRecord): boolean {
  return (call.responseBytes || 0) >= 400;
}

/**
 * Whether this explore should short-refuse instead of re-running.
 */
export function decideExploreRepeat(
  prior: ExploreProjectState | null | undefined,
  query: string,
): ExploreRepeatDecision {
  if (!prior || prior.calls.length === 0) return { refuse: false, reason: 'ok' };

  const qTokens = exploreQueryTokens(query);
  const counted = prior.calls.filter(isCountedCall);
  const novel = novelAnchorsVsPriors(query, prior.calls);
  const last = counted[counted.length - 1];

  // Hard fuse — never explore×N after two counted calls (inventory Manager hops included).
  if (counted.length >= MAX_EXPLORES) {
    return {
      refuse: true,
      matched: last,
      reason: 'hard-cap',
    };
  }

  // Partial named a Next anchor — follow-up MUST include that name (no novel-Type bypass).
  if (last?.partial && last.nextAnchor) {
    const na = last.nextAnchor.toLowerCase();
    if (!query.toLowerCase().includes(na)) {
      return {
        refuse: true,
        matched: last,
        reason: 'next-anchor',
      };
    }
  }

  // Overlap with any prior counted explore — unless a tight novel Type/file bag
  // (and, after Partial, only when Next anchor is already in the query above).
  if (novel.length > 0 && isTightExploreFollowUp(query)) {
    return { refuse: false, reason: 'ok' };
  }

  let best: ExploreCallRecord | undefined;
  let bestScore = 0;
  for (const call of counted) {
    const score = queryTokenOverlapScore(qTokens, exploreQueryTokens(call.query));
    if (score > bestScore) {
      bestScore = score;
      best = call;
    }
  }
  if (best && bestScore >= OVERLAP_THRESHOLD) {
    return { refuse: true, matched: best, reason: 'overlap' };
  }

  return { refuse: false, reason: 'ok' };
}

/** Short success-shaped refuse when a repeat explore would waste tokens. */
export function formatExploreRepeatRefuse(
  decision: ExploreRepeatDecision,
  query: string,
): string {
  const priorQ = decision.matched?.query?.trim().slice(0, 100) || '(earlier explore)';
  const files = (decision.matched?.files || []).map((f) => f.path).slice(0, 6);
  const fileLine = files.length > 0
    ? `\nAlready covered files include: ${files.map((f) => `\`${f}\``).join(', ')}.`
    : '';
  const next = decision.matched?.nextAnchor
    ? `\nPrior **Next anchor** was \`${decision.matched.nextAnchor}\` — use that name, or ONE narrow Grep.`
    : '';

  let why: string;
  switch (decision.reason) {
    case 'hard-cap':
      why = `This session already ran **${MAX_EXPLORES}** \`homegraph_explore\` calls on this project. Stop exploring.`;
      break;
    case 'next-anchor':
      why = `Prior explore was Partial and named a **Next anchor** — do not re-explore a paraphrase of "${priorQ}${priorQ.length >= 100 ? '…' : ''}".`;
      break;
    case 'call-budget':
      why = `Explore call budget exhausted for this project in the session.`;
      break;
    default:
      why = `This query overlaps a prior explore (bag ≈ "${priorQ}${priorQ.length >= 100 ? '…' : ''}").`;
  }

  return [
    '**Skip repeat explore — stop HomeGraph drill-down.**',
    why + fileLine + next,
    `Current query: "${query.trim().slice(0, 160)}${query.trim().length > 160 ? '…' : ''}"`,
    'Answer from Anchors / digests already in this conversation, or run **ONE narrow Grep** for residual unindexed wiring.',
    'Do **not** glob/read the whole repo, and do **not** fan out `homegraph_explore` / `homegraph_node` / callers on the same bag.',
  ].join('\n');
}

export interface DepthToolFuseDecision {
  refuse: boolean;
  reason: 'partial-depth-cap' | 'partial-no-callers' | 'ok';
  nextAnchor?: string;
}

/** Latest counted explore call (≥400 response bytes), if any. */
export function latestCountedExplore(
  prior: ExploreProjectState | null | undefined,
): ExploreCallRecord | undefined {
  if (!prior?.calls.length) return undefined;
  for (let i = prior.calls.length - 1; i >= 0; i--) {
    const c = prior.calls[i]!;
    if (isCountedCall(c)) return c;
  }
  return undefined;
}

/**
 * Whether `homegraph_node` / callers / callees should short-refuse after a
 * Partial explore (same failure class as explore×N — depth fan-out).
 *
 * After Partial: callers/callees are refused immediately (wrong tool + often a
 * multi-def token bomb). `homegraph_node` gets one shot, then refuse.
 */
export function decideDepthToolFuse(
  prior: ExploreProjectState | null | undefined,
  depthCallCount: number,
  toolName?: string,
): DepthToolFuseDecision {
  const last = latestCountedExplore(prior);
  if (!last?.partial) return { refuse: false, reason: 'ok' };
  const nextAnchor = last.nextAnchor;
  if (toolName === 'homegraph_callers' || toolName === 'homegraph_callees') {
    return {
      refuse: true,
      reason: 'partial-no-callers',
      nextAnchor,
    };
  }
  if (depthCallCount >= MAX_DEPTH_AFTER_PARTIAL) {
    return {
      refuse: true,
      reason: 'partial-depth-cap',
      nextAnchor,
    };
  }
  return { refuse: false, reason: 'ok', nextAnchor };
}

/** Success-shaped refuse when Partial already spent its one depth drill. */
export function formatDepthToolRefuse(
  decision: DepthToolFuseDecision,
  toolName: string,
  symbolHint?: string,
): string {
  const next = decision.nextAnchor
    ? `\nPrior **Next anchor** was \`${decision.nextAnchor}\` — ONE \`homegraph_node\` / tighter explore with that name, or ONE narrow Grep.`
    : '';
  const sym = symbolHint?.trim()
    ? `\nRequested: \`${symbolHint.trim().slice(0, 80)}\``
    : '';
  const why = decision.reason === 'partial-no-callers'
    ? `Prior \`homegraph_explore\` was a Partial locator — do **not** call \`${toolName}\` next (multi-def dumps + fan-out).`
    : `Prior \`homegraph_explore\` was a Partial locator; this session already used its **${MAX_DEPTH_AFTER_PARTIAL}** `
      + `allowed \`homegraph_node\` call on this project.`;
  return [
    '**Skip HomeGraph depth drill — stop after Partial.**',
    why + next + sym,
    'Answer from Anchors / digests already in this conversation, or run **ONE narrow Grep** for residual unindexed wiring.',
    'Do **not** fan out more `homegraph_node` / callers / callees, and do **not** glob/read the whole repo.',
  ].join('\n');
}

/** Candidate Type for Partial **Next anchor** / digest preference. */
export interface DomainRoleAnchorCandidate {
  name: string;
  kind: string;
  filePath: string;
  startLine?: number;
}

/**
 * Score a domain Manager/Service for Next-anchor / digest preference.
 * Prefer query-token overlap + *Manager /manager/ paths; demote weak *Utils /
 * *Constants / bare *Subscriber helpers without strong token overlap.
 *
 * `domainTokens` (from {@link mechanismDomainPathTokens}) carries CJK→ASCII
 * stems so NL asks like 通知订阅 rank SubscribeManager over screenlock StateManager.
 */
export function scoreDomainRoleForQuery(
  candidate: DomainRoleAnchorCandidate,
  query: string,
  domainTokens?: readonly string[],
): number {
  const tokens = [...exploreQueryTokens(query)].filter((t) => t.length >= 3);
  const domain = (domainTokens && domainTokens.length > 0
    ? domainTokens
    : mechanismDomainPathTokens(query)
  ).map((t) => t.toLowerCase()).filter((t) => t.length >= 4);
  const name = candidate.name || '';
  const fp = (candidate.filePath || '').toLowerCase().replace(/\\/g, '/');
  const nameLc = name.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (nameLc.includes(t)) score += 12;
    if (fp.includes(`/${t}/`)) score += 10;
    else if (fp.includes(t)) score += 4;
  }
  for (const t of domain) {
    if (nameLc.includes(t)) score += 14;
    if (fp.includes(`/${t}/`)) score += 12;
    else if (fp.includes(t)) score += 5;
  }
  if (/Manager$/i.test(name)) score += 8;
  if (/\/manager\//i.test(fp)) score += 5;
  if (/Service$/i.test(name)) score += 3;
  if (/SubscribeManager|SubscriberManager|EventManager|BridgeManager/i.test(name)) score += 4;
  // Intent-shaped role boosts (shape only — no product nouns beyond domain stems).
  if (/订阅|subscribe/i.test(query)) {
    if (/Subscribe(?:r)?Manager/i.test(name)) score += 22;
    if (/BridgeManager|EventManager/i.test(name) && /notif|subscribe/i.test(nameLc + fp)) score += 8;
    if (/StateManager$/i.test(name) && !/状态|state/i.test(query)) score -= 18;
    if (/screenlock|keyguard/i.test(fp) && !/锁屏|screenlock|keyguard/i.test(query)) score -= 14;
  }
  if (/备份|恢复|backup|restore/i.test(query)) {
    if (/Extension$/i.test(name) || /ExtensionAbility/i.test(name)) score += 22;
    if (/BackupLauncher|RestoreLauncher|DataRestore|Controller$/i.test(name)) score += 12;
    if (/EventManager$/i.test(name) && !/Extension/i.test(name)) score -= 6;
  }
  // Weak helpers: only keep if they already scored on tokens.
  if (/(Utils|Constants|Info|Entry|Helper)$/i.test(name)) score -= 8;
  if (/Subscriber$/i.test(name) && !/Manager/i.test(name) && score < 16) score -= 6;
  if (/Listener$/i.test(name) && !/Manager/i.test(name) && score < 16) score -= 4;
  return score;
}

/** Best domain-role Type for Next anchor, or undefined when inventory empty. */
export function pickBestDomainRoleAnchor(
  candidates: ReadonlyArray<DomainRoleAnchorCandidate>,
  query: string,
  domainTokens?: readonly string[],
): DomainRoleAnchorCandidate | undefined {
  if (!candidates.length) return undefined;
  let best: DomainRoleAnchorCandidate | undefined;
  let bestScore = -Infinity;
  for (const c of candidates) {
    if (!c?.name) continue;
    const s = scoreDomainRoleForQuery(c, query, domainTokens);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

/** Format Next anchor caption used in Partial / soft-close footers. */
export function formatNextAnchorCaption(c: DomainRoleAnchorCandidate): string {
  const line = c.startLine && c.startLine > 0 ? String(c.startLine) : '?';
  return `\`${c.name}\` (${c.kind}) — \`${c.filePath.replace(/\\/g, '/')}:${line}\``;
}

/**
 * Soft-close opening banner (must match footer — never pair with Partial locator).
 */
export function formatMechanismSoftCloseHeader(): string {
  return (
    '> **Coarse locate — ANSWER from anchors + digests below.** '
    + 'Treat inventory + Source as already Read. '
    + 'ONE narrow Grep only for residual unindexed wiring — do not re-explore or fan out depth tools.'
  );
}

/**
 * Soft-close footer: enough inventory + digest to answer without another explore.
 * Must NOT contain "Partial locator" so the session fuse treats the call as closed.
 */
export function formatMechanismSoftCloseFooter(next?: DomainRoleAnchorCandidate): string {
  const hint = next
    ? ` Primary Type: \`${next.name}\`.`
    : '';
  return (
    '> **Coarse locate — ANSWER from anchors + digests above.**'
    + hint
    + ' ONE narrow Grep only for residual unindexed wiring named above. '
    + 'Do **not** re-explore, fan out `homegraph_node` / callers, or glob/read the repo.'
  );
}

/** Honest Partial footer with a single Next anchor + ONE Grep. */
export function formatMechanismPartialFooter(nextCaption: string): string {
  return (
    '> **Partial locator** — not a full mechanism closure. '
    + `**Next anchor:** ${nextCaption}. `
    + 'ONE tighter `homegraph_explore` **only** with that exact name, '
    + 'or **ONE narrow Grep** for residual unindexed wiring — '
    + 'do **not** fan out `homegraph_node` / Read / glob, and do **not** ANSWER NOW from inventory alone.'
  );
}

/**
 * Appended when a second counted Partial is emitted in the same session —
 * stop HomeGraph; do not take a third explore.
 */
export function formatSecondPartialStopFooter(nextAnchor?: string): string {
  const next = nextAnchor
    ? `\nPrior **Next anchor:** \`${nextAnchor}\`.`
    : '';
  return [
    '',
    '---',
    '> **Second Partial — stop HomeGraph.** Do **not** call `homegraph_explore` again.'
    + next
    + ' Answer from Anchors / digests already returned, or **ONE narrow Grep** for residual unindexed wiring. '
    + 'Do not glob/read the whole repo.',
  ].join('\n');
}

/**
 * Intent phrases that must ride with a bare Type on Partial retry —
 * dropping them collapses data-source / event-dispatch surveys into empty compact.
 */
export function extractRetryIntentHints(query: string): string[] {
  const hints: string[] = [];
  const q = query.trim();
  if (/来源于|数据来源|状态来源|哪个系统服务|data\s+source|which\s+service/i.test(q)) {
    hints.push('数据来源 系统服务');
  }
  if (/分发|分发给|哪些\s*Manager|dispatch|DataShareMgr|事件类型/i.test(q)) {
    hints.push('事件类型 分发 Manager');
  }
  if (/调用链|跨模块|如何驱动|重新计算|multi[- ]?thread|多线程/i.test(q)) {
    hints.push('调用链');
  }
  return hints.slice(0, 2);
}

/**
 * Busy/deadline Partial with actionable anchors from the query (no DB).
 */
export function formatPartialExploreGuidance(opts: {
  seconds: number;
  query?: string;
  why?: string;
}): string {
  const secs = Math.max(1, opts.seconds);
  const why = opts.why
    || `HomeGraph did not finish within ${secs}s (deadline / busy / queue)`;
  const anchors = opts.query ? extractRetryAnchorsFromQuery(opts.query) : [];
  const intents = opts.query ? extractRetryIntentHints(opts.query) : [];
  const retryBits = [
    ...anchors.map((a) => `\`${a}\``),
    ...intents.map((h) => `\`${h}\``),
  ];
  const anchorLine = retryBits.length > 0
    ? `If you retry, ONE tight \`homegraph_explore\` using only: ${retryBits.join(', ')} `
      + '(not a paraphrase of the whole question).'
      + (intents.length > 0
        ? ' Keep the intent words with the Type.'
        : '')
    : 'If you retry, ONE tight \`homegraph_explore\` with a single Type / file / `@kit` name — not a broad paraphrase.';

  return [
    `⚠️ **Partial result** — ${why}. This is NOT an error.`,
    'Prefer **ONE narrow Grep** for residual unindexed wiring using names already in the question — do **not** glob/read the repo.',
    anchorLine,
    'At most **one** `homegraph_node` (or callers/callees) after Partial — further depth calls are refused. Do not open a Grep/Read storm.',
    'If a second explore still Partials, **stop HomeGraph** and answer from anchors + ONE narrow Grep.',
  ].join('\n');
}
