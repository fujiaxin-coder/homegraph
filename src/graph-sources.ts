/**
 * MCP / query-time graph source selection — project index vs OHOS SDK API db.
 *
 * Spec: docs/specs/0005-mcp-graph-sources-switch.md
 *
 * CLI: `homegraph serve mcp --sources both|project|sdk|none`
 * Env:  `HOMEGRAPH_SOURCES` (used when CLI omits --sources)
 * Priority: explicit CLI/options > env > `both`
 */

export const GRAPH_SOURCES_ENV = 'HOMEGRAPH_SOURCES';

export type GraphSourcesMode = 'both' | 'project' | 'sdk' | 'none';

export const GRAPH_SOURCES_MODES: readonly GraphSourcesMode[] = [
  'both',
  'project',
  'sdk',
  'none',
] as const;

export interface GraphSourceFlags {
  /** Include symbols from the project's `.homegraph` main graph. */
  project: boolean;
  /** ATTACH + query `~/.homegraph/api` OHOS API db. */
  sdk: boolean;
  /** Open a HomeGraph instance at all (false only for `none`). */
  openProjectDb: boolean;
}

const MODE_SET = new Set<string>(GRAPH_SOURCES_MODES);

/**
 * Parse a raw mode string. Returns null when empty/undefined (caller applies default).
 * Throws on non-empty invalid values.
 */
export function parseGraphSourcesMode(raw: string | undefined | null): GraphSourcesMode | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (!MODE_SET.has(lower)) {
    throw new Error(
      `Invalid graph sources "${raw}". Expected one of: ${GRAPH_SOURCES_MODES.join(', ')}`
    );
  }
  return lower as GraphSourcesMode;
}

/** Map mode → runtime flags. */
export function graphSourceFlags(mode: GraphSourcesMode): GraphSourceFlags {
  switch (mode) {
    case 'both':
      return { project: true, sdk: true, openProjectDb: true };
    case 'project':
      return { project: true, sdk: false, openProjectDb: true };
    case 'sdk':
      return { project: false, sdk: true, openProjectDb: true };
    case 'none':
      return { project: false, sdk: false, openProjectDb: false };
  }
}

/**
 * Resolve effective mode.
 * @param explicit - from `--sources` or `OpenOptions.sources` (wins over env)
 * @param env - defaults to `process.env.HOMEGRAPH_SOURCES`
 */
export function resolveGraphSources(
  explicit?: string | null,
  env: NodeJS.ProcessEnv = process.env
): GraphSourcesMode {
  const fromCli = parseGraphSourcesMode(explicit ?? undefined);
  if (fromCli) return fromCli;
  const fromEnv = parseGraphSourcesMode(env[GRAPH_SOURCES_ENV]);
  if (fromEnv) return fromEnv;
  return 'both';
}

/**
 * Apply CLI `--sources` into the process env so detached daemons and nested
 * opens in this process see the same mode without re-parsing argv.
 */
export function applyGraphSourcesToEnv(mode: GraphSourcesMode, env: NodeJS.ProcessEnv = process.env): void {
  env[GRAPH_SOURCES_ENV] = mode;
}

/** Short success-shaped guidance when sources=none (or no usable graph). */
export function graphSourcesDisabledGuidance(mode: GraphSourcesMode = resolveGraphSources()): string {
  return (
    `HomeGraph graph sources are set to "${mode}" — no project/SDK graph is available for this session. ` +
    `Pass \`--sources both|project|sdk\` on \`homegraph serve mcp\`, or set ${GRAPH_SOURCES_ENV}. ` +
    `Default is both (project index + OHOS SDK API db when bound).`
  );
}
