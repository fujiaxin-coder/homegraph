/**
 * Addon scaffold generator (`homegraph addon init`).
 *
 * Produces a publishable npm package skeleton with the `homegraph` marker,
 * an `enrich` stub, and a worked Jira example (parse ticket refs → fetch
 * details → return supplements).
 *
 * @module addons/init-template
 */

import * as fs from 'fs';
import * as path from 'path';

function packageJson(name: string, lang: 'js' | 'ts'): string {
  const entry = lang === 'ts' ? './dist/index.js' : './index.mjs';
  return JSON.stringify(
    {
      name,
      version: '0.1.0',
      description: 'HomeGraph addon: enrich spec-mine prompts with external requirement data',
      type: 'module',
      exports: { '.': entry },
      files: lang === 'ts' ? ['dist', 'examples'] : ['index.mjs', 'examples'],
      scripts: lang === 'ts' ? { build: 'tsc' } : undefined,
      // TypeScript needs the homegraph type declarations to compile.
      devDependencies: lang === 'ts' ? { homegraph: 'latest' } : undefined,
      homegraph: { addon: true, api: 1 },
    },
    null,
    2,
  ) + '\n';
}

function tsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        outDir: 'dist',
        declaration: true,
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
      },
      include: ['index.ts'],
    },
    null,
    2,
  ) + '\n';
}

/** Shared body of the enrich stub — identical for JS and TS. */
function enrichBody(): string {
  return `  const supplements = [];
  for (const commit of input.commits) {
    const match = /([A-Z]+-\\d+)/.exec(commit.commitMessage);
    if (match) {
      supplements.push({
        key: match[1],
        text: \`Requirement \${match[1]}: replace this with fetched details.\`,
        commitHash: commit.commitHash,
      });
    }
  }
  return supplements;
`;
}

function indexSource(name: string, lang: 'js' | 'ts'): string {
  const head = `/**
 * ${name} — HomeGraph spec-mine addon.
 *
 * Contract (api 1) — implement at least one hook:
 *   - enrich(input):  add external requirement context (e.g. Jira) as
 *                     supplements; HomeGraph dedupes by \`key\` and renders
 *                     them into a "## Supplement" prompt section.
 *   - buildPrompt(ctx): optional escape hatch that takes over the whole
 *                     prompt assembly (see ctx.limits — a soft contract).
 *
 * All data is passed in — you never run git. Return one Supplement per
 * requirement, keyed by an opaque id (e.g. the ticket key).
 `;

  if (lang === 'ts') {
    return (
      `import type { EnrichInput, Supplement } from 'homegraph';\n\n` +
      head +
      ` */\n\n` +
      `export async function enrich(input: EnrichInput): Promise<Supplement[]> {\n` +
      enrichBody() +
      `}\n`
    );
  }
  return (
    head +
    ` * @param {import('homegraph').EnrichInput} input - one commit cluster.
 * @returns {Promise<import('homegraph').Supplement[]>}
 */

export async function enrich(input) {
` +
    enrichBody() +
    `}
`
  );
}

const JIRA_EXAMPLE = `// Worked example: fetch requirement details from Jira and render them as
// supplements. Standalone — drop this file into any addon's examples/ dir.
//
//   const JIRA_BASE = process.env.JIRA_BASE_URL ?? 'https://your-domain.atlassian.net';
//   const JIRA_EMAIL = process.env.JIRA_EMAIL ?? '';
//   const JIRA_TOKEN = process.env.JIRA_API_TOKEN ?? '';
//   const TICKET_RE = /([A-Z]+-\\d+)/g;

export async function enrich(input) {
  const seen = new Set();
  const supplements = [];
  for (const commit of input.commits) {
    for (const match of commit.commitMessage.matchAll(TICKET_RE)) {
      const key = match[1];
      if (seen.has(key)) continue; // dedupe across commits in the cluster
      seen.add(key);
      supplements.push({ key, text: await fetchTicket(key), commitHash: commit.commitHash });
    }
  }
  return supplements;
}

async function fetchTicket(key) {
  if (!JIRA_TOKEN) return \`\${key}: set JIRA_API_TOKEN to fetch details.\`;
  const res = await fetch(\`\${JIRA_BASE}/rest/api/3/issue/\${key}\`, {
    headers: { Authorization: 'Basic ' + btoa(JIRA_EMAIL + ':' + JIRA_TOKEN) },
  });
  if (!res.ok) return \`\${key}: fetch failed (\${res.status}).\`;
  const issue = await res.json();
  const summary = issue.fields?.summary ?? '(no summary)';
  const description = issue.fields?.description ?? '';
  return \`\${key} — \${summary}\\n\${description}\`;
}
`;

const README = `# HomeGraph Addon

A pluggable extension for \`homegraph spec mine\`: enrich cluster prompts with
external requirement context (Jira, internal trackers, APIs) without
HomeGraph knowing any ticket format.

## Contract (api 1)

- \`enrich(input: { clusterId, commits: AddonCommitInput[] })\` → \`Supplement[]\`
  - HomeGraph passes every commit it already knows (hash, message, author,
    timestamp) — never re-run git.
  - Return one \`Supplement\` per requirement: \`{ key?, text, commitHash? }\`.
    \`key\` is an opaque dedupe id (e.g. the ticket key); without it, exact
    text match is used. HomeGraph renders them into a \`## Supplement\` section.
- \`buildPrompt(ctx)\` (optional escape hatch) — takes over prompt assembly
  entirely. \`ctx.limits\` is a soft contract you are expected to honor.

Implement at least one hook. The \`homegraph\` field in package.json must
declare \`{ "addon": true, "api": 1 }\`.

## Local usage

    homegraph addon install ./path/to/this/addon

See \`examples/jira.mjs\` for a full fetch → supplement example.
`;

/**
 * Create the addon scaffold in `parentDir/<name>`. Returns the paths of the
 * files created (absolute). Throws when the target directory already exists.
 */
export function createAddonScaffold(
  name: string,
  parentDir: string,
  lang: 'js' | 'ts',
): string[] {
  const addonDir = path.join(parentDir, name);
  if (fs.existsSync(addonDir)) {
    throw new Error(`Directory already exists: ${addonDir}`);
  }

  const files: Record<string, string> = {
    'package.json': packageJson(name, lang),
    README: README,
    'examples/jira.mjs': JIRA_EXAMPLE,
  };
  if (lang === 'ts') {
    files['tsconfig.json'] = tsconfig();
    files['index.ts'] = indexSource(name, lang);
  } else {
    files['index.mjs'] = indexSource(name, lang);
  }

  const created: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const filePath = path.join(addonDir, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    created.push(filePath);
  }
  return created;
}
