/**
 * Coding-Agent LLM Client Tests
 *
 * Covers:
 *   - src/spec/llm/agents/ (detection, resolution priority, adapters)
 *   - src/spec/llm/agent-client.ts (subprocess lifecycle, retry, timeout)
 *   - src/spec/llm/factory.ts (FallbackLlmClient, createSpecLlmClient)
 *
 * All subprocess tests use fake agent shell scripts on a temp PATH — real
 * Claude Code / Codex installations are never touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { silentLogger, setLogger } from '../src/errors';
import { resolveAgent, resetAgentResolutionCache } from '../src/spec/llm/agents';
import { claudeCodeAdapter } from '../src/spec/llm/agents/claude-code';
import { codexAdapter } from '../src/spec/llm/agents/codex';
import { AgentAdapter, AgentFailure } from '../src/spec/llm/agents/types';
import { CodingAgentLlmClient } from '../src/spec/llm/agent-client';
import { FallbackLlmClient, createSpecLlmClient } from '../src/spec/llm/factory';
import { OpenAiLlmClient, LlmClient } from '../src/spec/llm/client';
import { LLMConfig } from '../src/spec/config';

setLogger(silentLogger);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let savedPath: string | undefined;
let savedHome: string | undefined;
let savedOverride: string | undefined;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-agent-'));
}

/** Write an executable shell script into `dir` and return its full path. */
function writeScript(dir: string, name: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

/** Adapter stub that spawns a local script instead of a real agent. */
function makeScriptAdapter(
  scriptPath: string,
  classify?: (failure: AgentFailure) => 'retryable' | 'terminal',
): AgentAdapter {
  return {
    id: 'claude-code',
    displayName: 'FakeAgent',
    binary: scriptPath,
    detect: () => true,
    buildInvocation: (systemPrompt, userPrompt) => ({
      args: [],
      stdin: `${systemPrompt}\n${userPrompt}`,
    }),
    extractOutput: (r) => r.stdout.trim(),
    classifyFailure: classify ?? ((f) => (f.exitCode === null ? 'terminal' : 'retryable')),
  };
}

const fakeLlmConfig: LLMConfig = {
  provider: 'openai',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  temperature: 0.2,
  maxTokens: 100,
  maxRetries: 0,
  retryBaseDelayMs: 1,
  retryMaxDelayMs: 10,
};

beforeEach(() => {
  tmpDir = makeTmpDir();
  savedPath = process.env.PATH;
  savedHome = process.env.HOME;
  savedOverride = process.env.HOMEGRAPH_SPEC_AGENT;
});

afterEach(() => {
  process.env.PATH = savedPath;
  process.env.HOME = savedHome;
  if (savedOverride === undefined) {
    delete process.env.HOMEGRAPH_SPEC_AGENT;
  } else {
    process.env.HOMEGRAPH_SPEC_AGENT = savedOverride;
  }
  resetAgentResolutionCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Detection & resolution
// ---------------------------------------------------------------------------

describe('agents — detection & resolution', () => {
  it('resolves claude-code when only claude is on PATH', () => {
    writeScript(tmpDir, 'claude', '#!/bin/sh\nexit 0\n');
    process.env.PATH = tmpDir;
    process.env.HOME = tmpDir; // no ~/.claude / ~/.codex here
    delete process.env.HOMEGRAPH_SPEC_AGENT;
    resetAgentResolutionCache();

    expect(resolveAgent()?.id).toBe('claude-code');
  });

  it('resolves codex when only codex is on PATH', () => {
    writeScript(tmpDir, 'codex', '#!/bin/sh\nexit 0\n');
    process.env.PATH = tmpDir;
    process.env.HOME = tmpDir;
    delete process.env.HOMEGRAPH_SPEC_AGENT;
    resetAgentResolutionCache();

    expect(resolveAgent()?.id).toBe('codex');
  });

  it('prefers claude-code when both are installed', () => {
    writeScript(tmpDir, 'claude', '#!/bin/sh\nexit 0\n');
    writeScript(tmpDir, 'codex', '#!/bin/sh\nexit 0\n');
    process.env.PATH = tmpDir;
    process.env.HOME = tmpDir;
    delete process.env.HOMEGRAPH_SPEC_AGENT;
    resetAgentResolutionCache();

    expect(resolveAgent()?.id).toBe('claude-code');
  });

  it('returns null when nothing is installed', () => {
    process.env.PATH = tmpDir; // empty dir
    process.env.HOME = tmpDir;
    delete process.env.HOMEGRAPH_SPEC_AGENT;
    resetAgentResolutionCache();

    expect(resolveAgent()).toBeNull();
  });

  it('does NOT detect via a leftover config directory alone (uninstalled agent)', () => {
    // Uninstalling the CLI leaves ~/.claude / ~/.codex behind — that must
    // not count as "installed" (real-world false positive).
    fs.mkdirSync(path.join(tmpDir, '.claude'));
    fs.mkdirSync(path.join(tmpDir, '.codex'));
    process.env.PATH = tmpDir;
    process.env.HOME = tmpDir;
    delete process.env.HOMEGRAPH_SPEC_AGENT;
    resetAgentResolutionCache();

    expect(resolveAgent()).toBeNull();
  });

  it('detects claude via well-known install path when not on PATH', () => {
    writeScript(path.join(tmpDir, '.claude', 'local'), 'claude', '#!/bin/sh\nexit 0\n');
    process.env.PATH = tmpDir;
    process.env.HOME = tmpDir;
    delete process.env.HOMEGRAPH_SPEC_AGENT;
    resetAgentResolutionCache();

    expect(resolveAgent()?.id).toBe('claude-code');
  });

  it('detects codex via well-known install path when not on PATH', () => {
    writeScript(path.join(tmpDir, '.local', 'bin'), 'codex', '#!/bin/sh\nexit 0\n');
    process.env.PATH = tmpDir;
    process.env.HOME = tmpDir;
    delete process.env.HOMEGRAPH_SPEC_AGENT;
    resetAgentResolutionCache();

    expect(resolveAgent()?.id).toBe('codex');
  });

  it("HOMEGRAPH_SPEC_AGENT='none' forces null even with binaries present", () => {
    writeScript(tmpDir, 'claude', '#!/bin/sh\nexit 0\n');
    process.env.PATH = tmpDir;
    process.env.HOME = tmpDir;
    process.env.HOMEGRAPH_SPEC_AGENT = 'none';
    resetAgentResolutionCache();

    expect(resolveAgent()).toBeNull();
  });

  it("HOMEGRAPH_SPEC_AGENT='codex' forces codex without detection", () => {
    process.env.PATH = tmpDir;
    process.env.HOME = tmpDir;
    process.env.HOMEGRAPH_SPEC_AGENT = 'codex';
    resetAgentResolutionCache();

    expect(resolveAgent()?.id).toBe('codex');
  });
});

// ---------------------------------------------------------------------------
// Claude Code adapter
// ---------------------------------------------------------------------------

describe('ClaudeCodeAdapter', () => {
  it('buildInvocation uses print mode, JSON output, disabled tools, native system prompt', () => {
    const inv = claudeCodeAdapter.buildInvocation('SYS', 'USER');
    expect(inv.args).toContain('-p');
    expect(inv.args).toContain('--output-format');
    expect(inv.args).toContain('json');
    expect(inv.args).toContain('--allowedTools');
    expect(inv.args).toContain('--system-prompt');
    expect(inv.args[inv.args.indexOf('--system-prompt') + 1]).toBe('SYS');
    expect(inv.args[inv.args.indexOf('--allowedTools') + 1]).toBe('');
    expect(inv.stdin).toBe('USER');
  });

  it('extractOutput unwraps the JSON envelope result field', () => {
    const stdout = JSON.stringify({ type: 'result', result: '# Spec\nContent.', is_error: false });
    expect(claudeCodeAdapter.extractOutput({ stdout, stderr: '' })).toBe('# Spec\nContent.');
  });

  it('extractOutput throws on is_error envelopes', () => {
    const stdout = JSON.stringify({ is_error: true, result: 'quota exhausted' });
    expect(() => claudeCodeAdapter.extractOutput({ stdout, stderr: '' })).toThrow(/error result/);
  });

  it('extractOutput falls back to raw stdout when not JSON', () => {
    expect(claudeCodeAdapter.extractOutput({ stdout: 'plain text\n', stderr: '' })).toBe('plain text');
  });

  it('classifyFailure: spawn failure is terminal', () => {
    expect(claudeCodeAdapter.classifyFailure({ exitCode: null, stdout: '', stderr: '' })).toBe('terminal');
  });

  it('classifyFailure: auth/quota stderr is terminal', () => {
    expect(claudeCodeAdapter.classifyFailure({ exitCode: 1, stdout: '', stderr: 'Error: not logged in, please run /login' })).toBe('terminal');
    expect(claudeCodeAdapter.classifyFailure({ exitCode: 1, stdout: '', stderr: 'usage limit exceeded for this period' })).toBe('terminal');
  });

  it('classifyFailure: generic non-zero exit is retryable', () => {
    expect(claudeCodeAdapter.classifyFailure({ exitCode: 1, stdout: '', stderr: 'something unexpected' })).toBe('retryable');
  });
});

// ---------------------------------------------------------------------------
// Codex adapter
// ---------------------------------------------------------------------------

describe('CodexAdapter', () => {
  it('buildInvocation uses read-only sandbox, JSONL output, stdin prompt', () => {
    const inv = codexAdapter.buildInvocation('SYS', 'USER');
    expect(inv.args[0]).toBe('exec');
    expect(inv.args).toContain('--sandbox');
    expect(inv.args[inv.args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(inv.args).toContain('--skip-git-repo-check');
    expect(inv.args).toContain('--json');
    expect(inv.args).not.toContain('--output-last-message');
    expect(inv.args[inv.args.length - 1]).toBe('-');
    // System prompt embedded in an instructions block (no native flag)
    expect(inv.stdin).toContain('<instructions>\nSYS\n</instructions>');
    expect(inv.stdin).toContain('USER');
  });

  it('extractOutput takes the last agent_message from the JSONL event stream', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"thinking..."}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"# Spec\\n\\nBody."}}',
      '{"type":"turn.completed","usage":{"output_tokens":20}}',
    ].join('\n');
    expect(codexAdapter.extractOutput({ stdout, stderr: '' })).toBe('# Spec\n\nBody.');
  });

  it('extractOutput ignores error/config-noise events and non-JSON lines', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"deprecated config"}}',
      'some plain log line',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Real answer."}}',
    ].join('\n');
    expect(codexAdapter.extractOutput({ stdout, stderr: '' })).toBe('Real answer.');
  });

  it('extractOutput tolerates a "message" field on agent_message items', () => {
    const stdout = '{"type":"item.completed","item":{"type":"agent_message","message":"alt field"}}';
    expect(codexAdapter.extractOutput({ stdout, stderr: '' })).toBe('alt field');
  });

  it('extractOutput returns empty when events contain no agent message', () => {
    const stdout = '{"type":"turn.failed","error":{"message":"boom"}}';
    expect(codexAdapter.extractOutput({ stdout, stderr: '' })).toBe('');
  });

  it('extractOutput falls back to noise-stripped stdout for non-JSONL output', () => {
    const out = codexAdapter.extractOutput({
      stdout: 'line one\ntokens used: 42\nline two\n',
      stderr: '',
    });
    expect(out).toBe('line one\nline two');
  });

  it('classifyFailure matches auth/quota patterns on stderr and stdout', () => {
    expect(codexAdapter.classifyFailure({ exitCode: null, stdout: '', stderr: '' })).toBe('terminal');
    expect(codexAdapter.classifyFailure({ exitCode: 1, stdout: '', stderr: 'not logged in' })).toBe('terminal');
    // Codex reports auth errors as JSONL error events on stdout too
    const stdout401 = '{"type":"error","message":"unexpected status 401 Unauthorized: Incorrect API key"}';
    expect(codexAdapter.classifyFailure({ exitCode: 1, stdout: stdout401, stderr: '' })).toBe('terminal');
    expect(codexAdapter.classifyFailure({ exitCode: 1, stdout: '', stderr: 'unexpected crash' })).toBe('retryable');
  });
});

// ---------------------------------------------------------------------------
// CodingAgentLlmClient — subprocess lifecycle with fake agent scripts
// ---------------------------------------------------------------------------

describe('CodingAgentLlmClient', () => {
  it('returns extracted output on success', async () => {
    const script = writeScript(tmpDir, 'fake-agent', '#!/bin/sh\ncat >/dev/null\necho "agent says hi"\n');
    const client = new CodingAgentLlmClient(makeScriptAdapter(script));
    await expect(client.chat('sys', 'user')).resolves.toBe('agent says hi');
  });

  it('retries transient failures and eventually succeeds', async () => {
    const counter = path.join(tmpDir, 'count');
    const script = writeScript(
      tmpDir,
      'flaky-agent',
      `#!/bin/sh
cat >/dev/null
N=$(cat "${counter}" 2>/dev/null || echo 0)
N=$((N+1))
echo $N > "${counter}"
if [ "$N" -lt 2 ]; then
  echo "boom" >&2
  exit 1
fi
echo "recovered"
`,
    );
    const client = new CodingAgentLlmClient(makeScriptAdapter(script), {
      maxRetries: 2,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
    });
    await expect(client.chat('sys', 'user')).resolves.toBe('recovered');
    expect(fs.readFileSync(counter, 'utf-8').trim()).toBe('2');
  });

  it('throws immediately on terminal failure without retrying', async () => {
    const counter = path.join(tmpDir, 'count-terminal');
    const script = writeScript(
      tmpDir,
      'terminal-agent',
      `#!/bin/sh
cat >/dev/null
N=$(cat "${counter}" 2>/dev/null || echo 0)
N=$((N+1))
echo $N > "${counter}"
echo "not logged in" >&2
exit 1
`,
    );
    const client = new CodingAgentLlmClient(
      makeScriptAdapter(script, () => 'terminal'),
      { maxRetries: 3, retryBaseDelayMs: 1, retryMaxDelayMs: 5 },
    );
    await expect(client.chat('sys', 'user')).rejects.toThrow(/exited with code 1/);
    expect(fs.readFileSync(counter, 'utf-8').trim()).toBe('1');
  });

  it('throws after exhausting retries on persistent transient failure', async () => {
    const script = writeScript(tmpDir, 'always-fail', '#!/bin/sh\ncat >/dev/null\necho "x" >&2\nexit 1\n');
    const client = new CodingAgentLlmClient(makeScriptAdapter(script), {
      maxRetries: 1,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
    });
    await expect(client.chat('sys', 'user')).rejects.toThrow(/exited with code 1/);
  });

  it('kills the process on timeout', async () => {
    const script = writeScript(tmpDir, 'slow-agent', '#!/bin/sh\ncat >/dev/null\nsleep 10\n');
    const client = new CodingAgentLlmClient(makeScriptAdapter(script), {
      timeoutMs: 300,
      maxRetries: 0,
    });
    await expect(client.chat('sys', 'user')).rejects.toThrow(/timed out/);
  });

  it('retries after a timeout and succeeds on a later attempt', async () => {
    const counter = path.join(tmpDir, 'count-timeout');
    const script = writeScript(
      tmpDir,
      'slow-then-fast',
      `#!/bin/sh
cat >/dev/null
N=$(cat "${counter}" 2>/dev/null || echo 0)
N=$((N+1))
echo $N > "${counter}"
if [ "$N" -lt 2 ]; then
  sleep 10
fi
echo "fast response"
`,
    );
    const client = new CodingAgentLlmClient(makeScriptAdapter(script), {
      // Generous timeout: macOS exec warm-up on a fresh script file can
      // take several hundred ms; 300ms proved flaky.
      timeoutMs: 2000,
      maxRetries: 1,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
    });
    await expect(client.chat('sys', 'user')).resolves.toBe('fast response');
    expect(fs.readFileSync(counter, 'utf-8').trim()).toBe('2');
  });

  it('kills the call when output exceeds the cap', async () => {
    const counter = path.join(tmpDir, 'count-cap');
    const script = writeScript(
      tmpDir,
      'flooding-agent',
      `#!/bin/sh
cat >/dev/null
N=$(cat "${counter}" 2>/dev/null || echo 0)
N=$((N+1))
echo $N > "${counter}"
head -c 10000 /dev/zero | tr '\\0' 'x'
`,
    );
    const client = new CodingAgentLlmClient(makeScriptAdapter(script), {
      maxOutputChars: 64,
      maxRetries: 2,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
    });
    await expect(client.chat('sys', 'user')).rejects.toThrow(/exceeded the 64-char stdout limit/);
    // exitCode null → terminal per the adapters → no retry
    expect(fs.readFileSync(counter, 'utf-8').trim()).toBe('1');
  });

  it('throws terminal when the binary does not exist (ENOENT)', async () => {
    const adapter = makeScriptAdapter(path.join(tmpDir, 'no-such-binary'));
    const client = new CodingAgentLlmClient(adapter, { maxRetries: 2, retryBaseDelayMs: 1 });
    await expect(client.chat('sys', 'user')).rejects.toThrow(/Failed to spawn/);
  });

  it('chatJson parses fenced JSON output', async () => {
    const script = writeScript(
      tmpDir,
      'json-agent',
      '#!/bin/sh\ncat >/dev/null\nprintf \'Here is the result:\\n```json\\n{"action":"UPDATE"}\\n```\\n\'\n',
    );
    const client = new CodingAgentLlmClient(makeScriptAdapter(script));
    await expect(client.chatJson('sys', 'user')).resolves.toEqual({ action: 'UPDATE' });
  });

  it('delivers the prompt via stdin', async () => {
    const script = writeScript(tmpDir, 'echo-agent', '#!/bin/sh\ncat\n');
    const client = new CodingAgentLlmClient(makeScriptAdapter(script));
    await expect(client.chat('SYS-PART', 'USER-PART')).resolves.toBe('SYS-PART\nUSER-PART');
  });
});

// ---------------------------------------------------------------------------
// FallbackLlmClient
// ---------------------------------------------------------------------------

describe('FallbackLlmClient', () => {
  function stubClient(impl: () => Promise<string>): LlmClient {
    return {
      chat: vi.fn(impl),
      chatJson: vi.fn(async () => ({ ok: true })),
    };
  }

  it('returns the primary result when it succeeds', async () => {
    const primary = stubClient(async () => 'from-agent');
    const secondary = stubClient(async () => 'from-api');
    const client = new FallbackLlmClient(primary, secondary);

    await expect(client.chat('s', 'u')).resolves.toBe('from-agent');
    expect(secondary.chat).not.toHaveBeenCalled();
  });

  it('falls back to the secondary when the primary fails', async () => {
    const primary = stubClient(async () => { throw new Error('agent down'); });
    const secondary = stubClient(async () => 'from-api');
    const client = new FallbackLlmClient(primary, secondary);

    await expect(client.chat('s', 'u')).resolves.toBe('from-api');
    expect(secondary.chat).toHaveBeenCalledOnce();
  });

  it('propagates the secondary error when both fail', async () => {
    const primary = stubClient(async () => { throw new Error('agent down'); });
    const secondary = stubClient(async () => { throw new Error('api down'); });
    const client = new FallbackLlmClient(primary, secondary);

    await expect(client.chat('s', 'u')).rejects.toThrow('api down');
  });
});

// ---------------------------------------------------------------------------
// createSpecLlmClient
// ---------------------------------------------------------------------------

describe('createSpecLlmClient', () => {
  it('returns undefined when no agent and no LLM config', () => {
    process.env.HOMEGRAPH_SPEC_AGENT = 'none';
    resetAgentResolutionCache();
    expect(createSpecLlmClient(null)).toBeUndefined();
  });

  it('returns OpenAiLlmClient when agent disabled and config present', () => {
    process.env.HOMEGRAPH_SPEC_AGENT = 'none';
    resetAgentResolutionCache();
    const client = createSpecLlmClient(fakeLlmConfig);
    expect(client).toBeInstanceOf(OpenAiLlmClient);
  });

  it('returns CodingAgentLlmClient when agent forced and no config', () => {
    process.env.HOMEGRAPH_SPEC_AGENT = 'claude-code';
    resetAgentResolutionCache();
    const client = createSpecLlmClient(null);
    expect(client).toBeInstanceOf(CodingAgentLlmClient);
  });

  it('returns FallbackLlmClient when both agent and config are available', () => {
    process.env.HOMEGRAPH_SPEC_AGENT = 'claude-code';
    resetAgentResolutionCache();
    const client = createSpecLlmClient(fakeLlmConfig);
    expect(client).toBeInstanceOf(FallbackLlmClient);
  });
});
