/**
 * Coding-Agent LLM Client Tests
 *
 * Covers:
 *   - src/spec/llm/agents/ (detection, resolution priority, adapters)
 *   - src/spec/llm/agent-client.ts (subprocess lifecycle, retry, timeout)
 *   - src/spec/llm/factory.ts (FallbackLlmClient, createSpecLlmClient)
 *
 * All subprocess tests use fake agent shell scripts on a temp PATH ? real
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
import { devecoCodeAdapter } from '../src/spec/llm/agents/deveco-code';
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
let savedUserProfile: string | undefined;
let savedOverride: string | undefined;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-agent-'));
}

/** Write a PATH-detectable stub binary (exit 0). Uses `.cmd` on Windows. */
function writeDetectStub(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const cmd = path.join(dir, `${name}.cmd`);
    const body = '@echo off\r\nexit /b 0\r\n';
    fs.writeFileSync(cmd, body);
    // Well-known install paths check the bare name (no .cmd); PATH lookup tries both.
    fs.writeFileSync(path.join(dir, name), body);
    return cmd;
  }
  const p = path.join(dir, name);
  fs.writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return p;
}

/**
 * Write a spawnable fake agent as CommonJS. Always run via `node` through
 * {@link makeScriptAdapter} so Windows does not need shebang/`.cmd` spawn.
 */
function writeAgentScript(dir: string, name: string, nodeBody: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const jsPath = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(jsPath, nodeBody);
  return jsPath;
}

/** Drain stdin then run `fn`. Used by fake agents that ignore the prompt body. */
function agentPreamble(): string {
  return `
const fs = require('fs');
function drainStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.resume();
  });
}
`;
}

/** Adapter stub that spawns a local script instead of a real agent. */
function makeScriptAdapter(
  scriptPath: string,
  classify?: (failure: AgentFailure) => 'retryable' | 'terminal',
): AgentAdapter {
  const runViaNode = scriptPath.endsWith('.cjs') || scriptPath.endsWith('.js');
  return {
    id: 'claude-code',
    displayName: 'FakeAgent',
    binary: runViaNode ? process.execPath : scriptPath,
    detect: () => true,
    buildInvocation: (systemPrompt, userPrompt) => ({
      args: runViaNode ? [scriptPath] : [],
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
  savedUserProfile = process.env.USERPROFILE;
  savedOverride = process.env.HOMEGRAPH_SPEC_AGENT;
});

afterEach(() => {
  process.env.PATH = savedPath;
  process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  if (savedOverride === undefined) {
    delete process.env.HOMEGRAPH_SPEC_AGENT;
  } else {
    process.env.HOMEGRAPH_SPEC_AGENT = savedOverride;
  }
  resetAgentResolutionCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Point os.homedir() at the temp dir on both POSIX (HOME) and Windows (USERPROFILE). */
function useTempHome(): void {
  process.env.HOME = tmpDir;
  process.env.USERPROFILE = tmpDir;
}

// ---------------------------------------------------------------------------
// Detection & resolution
// ---------------------------------------------------------------------------

describe('agents ? detection & resolution', () => {
  it('resolves claude-code when only claude is on PATH', () => {
    writeDetectStub(tmpDir, 'claude');
    process.env.PATH = tmpDir;
    useTempHome(); // no ~/.claude / ~/.codex here
    delete process.env.HOMEGRAPH_SPEC_AGENT;
    resetAgentResolutionCache();

    expect(resolveAgent()?.id).toBe('claude-code');
  });

  it('resolves codex when only codex is on PATH', () => {
    writeDetectStub(tmpDir, 'codex');
    process.env.PATH = tmpDir;
    useTempHome();
    delete process.env.HOMEGRAPH_SPEC_AGENT;
    resetAgentResolutionCache();

    expect(resolveAgent()?.id).toBe('codex');
  });

  it('prefers claude-code when both are installed', () => {
    writeDetectStub(tmpDir, 'claude');
    writeDetectStub(tmpDir, 'codex');
    process.env.PATH = tmpDir;
    useTempHome();
    delete process.env.HOMEGRAPH_SPEC_AGENT;
    resetAgentResolutionCache();

    expect(resolveAgent()?.id).toBe('claude-code');
  });

  it('returns null when nothing is installed', () => {
    process.env.PATH = tmpDir; // empty dir
    useTempHome();
    delete process.env.HOMEGRAPH_SPEC_AGENT;
    resetAgentResolutionCache();

    expect(resolveAgent()).toBeNull();
  });

  it('does NOT detect via a leftover config directory alone (uninstalled agent)', () => {
    // Uninstalling the CLI leaves ~/.claude / ~/.codex behind ? that must
    // not count as "installed" (real-world false positive).
    fs.mkdirSync(path.join(tmpDir, '.claude'));
    fs.mkdirSync(path.join(tmpDir, '.codex'));
    process.env.PATH = tmpDir;
    useTempHome();
    delete process.env.HOMEGRAPH_SPEC_AGENT;
    resetAgentResolutionCache();

    expect(resolveAgent()).toBeNull();
  });

  it('detects claude via well-known install path when not on PATH', () => {
    writeDetectStub(path.join(tmpDir, '.claude', 'local'), 'claude');
    process.env.PATH = tmpDir;
    useTempHome();
    delete process.env.HOMEGRAPH_SPEC_AGENT;
    resetAgentResolutionCache();

    expect(resolveAgent()?.id).toBe('claude-code');
  });

  it('detects codex via well-known install path when not on PATH', () => {
    writeDetectStub(path.join(tmpDir, '.local', 'bin'), 'codex');
    process.env.PATH = tmpDir;
    useTempHome();
    delete process.env.HOMEGRAPH_SPEC_AGENT;
    resetAgentResolutionCache();

    expect(resolveAgent()?.id).toBe('codex');
  });

  it("HOMEGRAPH_SPEC_AGENT='none' forces null even with binaries present", () => {
    writeDetectStub(tmpDir, 'claude');
    process.env.PATH = tmpDir;
    useTempHome();
    process.env.HOMEGRAPH_SPEC_AGENT = 'none';
    resetAgentResolutionCache();

    expect(resolveAgent()).toBeNull();
  });

  it("HOMEGRAPH_SPEC_AGENT='codex' forces codex without detection", () => {
    process.env.PATH = tmpDir;
    useTempHome();
    process.env.HOMEGRAPH_SPEC_AGENT = 'codex';
    resetAgentResolutionCache();

    expect(resolveAgent()?.id).toBe('codex');
  });

  it('resolves deveco-code when only deveco is on PATH', () => {
    writeDetectStub(tmpDir, 'deveco');
    process.env.PATH = tmpDir;
    useTempHome();
    delete process.env.HOMEGRAPH_SPEC_AGENT;
    resetAgentResolutionCache();

    expect(resolveAgent()?.id).toBe('deveco-code');
  });

  it('detects deveco via well-known install path when not on PATH', () => {
    writeDetectStub(path.join(tmpDir, '.local', 'bin'), 'deveco');
    process.env.PATH = tmpDir;
    useTempHome();
    delete process.env.HOMEGRAPH_SPEC_AGENT;
    resetAgentResolutionCache();

    expect(resolveAgent()?.id).toBe('deveco-code');
  });

  it("HOMEGRAPH_SPEC_AGENT='deveco-code' forces deveco-code without detection", () => {
    process.env.PATH = tmpDir;
    useTempHome();
    process.env.HOMEGRAPH_SPEC_AGENT = 'deveco-code';
    resetAgentResolutionCache();

    expect(resolveAgent()?.id).toBe('deveco-code');
  });

  it('claude-code preferred over deveco-code when both are on PATH', () => {
    writeDetectStub(tmpDir, 'claude');
    writeDetectStub(tmpDir, 'deveco');
    process.env.PATH = tmpDir;
    useTempHome();
    delete process.env.HOMEGRAPH_SPEC_AGENT;
    resetAgentResolutionCache();

    expect(resolveAgent()?.id).toBe('claude-code');
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
// DevEco Code adapter
// ---------------------------------------------------------------------------

describe('DevecoCodeAdapter', () => {
  it('buildInvocation uses explore agent, JSON output, stdin prompt', () => {
    const inv = devecoCodeAdapter.buildInvocation('SYS', 'USER');
    // Mode
    expect(inv.args[0]).toBe('run');
    // Read-only agent
    expect(inv.args).toContain('--agent');
    expect(inv.args[inv.args.indexOf('--agent') + 1]).toBe('explore');
    // JSON output
    expect(inv.args).toContain('--format');
    expect(inv.args[inv.args.indexOf('--format') + 1]).toBe('json');
    // System prompt embedded (no native flag)
    expect(inv.stdin).toContain('<instructions>\nSYS\n</instructions>');
    expect(inv.stdin).toContain('USER');
    // Prompt delivered via stdin, not as positional arg
    expect(inv.args.filter(a => a.includes('<instructions>')).length).toBe(0);
  });

  it('extractOutput concatenates text events from the JSONL stream', () => {
    const stdout = [
      '{"type":"text","timestamp":1000,"sessionID":"s1",'
        + '"part":{"type":"text","text":"# Spec Title"}}',
      '{"type":"tool_use","timestamp":1001,"sessionID":"s1",'
        + '"part":{"type":"tool","tool":"read","state":{"status":"completed"}}}',
      '{"type":"text","timestamp":1002,"sessionID":"s1",'
        + '"part":{"type":"text","text":"\\n\\nBody content."}}',
      '{"type":"step_finish","timestamp":1003,"sessionID":"s1",'
        + '"part":{"type":"step-finish","reason":"stop"}}',
    ].join('\n');
    expect(devecoCodeAdapter.extractOutput({ stdout, stderr: '' }))
      .toBe('# Spec Title\n\nBody content.');
  });

  it('extractOutput ignores reasoning events and non-text events', () => {
    const stdout = [
      '{"type":"reasoning","timestamp":1000,"sessionID":"s1",'
        + '"part":{"type":"reasoning","text":"Let me think..."}}',
      '{"type":"text","timestamp":1001,"sessionID":"s1",'
        + '"part":{"type":"text","text":"Final answer."}}',
    ].join('\n');
    expect(devecoCodeAdapter.extractOutput({ stdout, stderr: '' }))
      .toBe('Final answer.');
  });

  it('extractOutput returns empty when events contain no text', () => {
    const stdout = '{"type":"error","timestamp":1000,"sessionID":"s1",'
      + '"error":{"name":"SomeError"}}';
    expect(devecoCodeAdapter.extractOutput({ stdout, stderr: '' })).toBe('');
  });

  it('extractOutput falls back to noise-stripped stdout for non-JSONL output', () => {
    const out = devecoCodeAdapter.extractOutput({
      stdout: 'deveco: initializing\nplain output\ndeveco: done\n',
      stderr: '',
    });
    expect(out).toBe('plain output');
  });

  it('classifyFailure: spawn failure is terminal', () => {
    expect(devecoCodeAdapter.classifyFailure({
      exitCode: null, stdout: '', stderr: '',
    })).toBe('terminal');
  });

  it('classifyFailure: auth/quota stderr is terminal', () => {
    expect(devecoCodeAdapter.classifyFailure({
      exitCode: 1, stdout: '',
      stderr: 'Error: not logged in, please run /login',
    })).toBe('terminal');
    expect(devecoCodeAdapter.classifyFailure({
      exitCode: 1, stdout: '',
      stderr: 'usage limit exceeded for this period',
    })).toBe('terminal');
  });

  it('classifyFailure: generic non-zero exit is retryable', () => {
    expect(devecoCodeAdapter.classifyFailure({
      exitCode: 1, stdout: '', stderr: 'unexpected crash',
    })).toBe('retryable');
  });
});

// ---------------------------------------------------------------------------
// CodingAgentLlmClient ? subprocess lifecycle with fake agent scripts
// ---------------------------------------------------------------------------

describe('CodingAgentLlmClient', () => {
  it('returns extracted output on success', async () => {
    const script = writeAgentScript(
      tmpDir,
      'fake-agent',
      `${agentPreamble()}
(async () => {
  await drainStdin();
  process.stdout.write('agent says hi\\n');
})();
`,
    );
    const client = new CodingAgentLlmClient(makeScriptAdapter(script));
    await expect(client.chat('sys', 'user')).resolves.toBe('agent says hi');
  });

  it('retries transient failures and eventually succeeds', async () => {
    const script = writeAgentScript(
      tmpDir,
      'flaky-agent',
      `${agentPreamble()}
(async () => {
  await drainStdin();
  const counter = ${JSON.stringify(path.join(tmpDir, 'count'))};
  let n = 0;
  try { n = parseInt(fs.readFileSync(counter, 'utf8').trim(), 10) || 0; } catch {}
  n += 1;
  fs.writeFileSync(counter, String(n));
  if (n < 2) {
    process.stderr.write('boom\\n');
    process.exit(1);
  }
  process.stdout.write('recovered\\n');
})();
`,
    );
    const client = new CodingAgentLlmClient(makeScriptAdapter(script), {
      maxRetries: 2,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
    });
    await expect(client.chat('sys', 'user')).resolves.toBe('recovered');
    expect(fs.readFileSync(path.join(tmpDir, 'count'), 'utf-8').trim()).toBe('2');
  });

  it('throws immediately on terminal failure without retrying', async () => {
    const script = writeAgentScript(
      tmpDir,
      'terminal-agent',
      `${agentPreamble()}
(async () => {
  await drainStdin();
  const counter = ${JSON.stringify(path.join(tmpDir, 'count-terminal'))};
  let n = 0;
  try { n = parseInt(fs.readFileSync(counter, 'utf8').trim(), 10) || 0; } catch {}
  n += 1;
  fs.writeFileSync(counter, String(n));
  process.stderr.write('not logged in\\n');
  process.exit(1);
})();
`,
    );
    const client = new CodingAgentLlmClient(
      makeScriptAdapter(script, () => 'terminal'),
      { maxRetries: 3, retryBaseDelayMs: 1, retryMaxDelayMs: 5 },
    );
    await expect(client.chat('sys', 'user')).rejects.toThrow(/exited with code 1/);
    expect(fs.readFileSync(path.join(tmpDir, 'count-terminal'), 'utf-8').trim()).toBe('1');
  });

  it('throws after exhausting retries on persistent transient failure', async () => {
    const script = writeAgentScript(
      tmpDir,
      'always-fail',
      `${agentPreamble()}
(async () => {
  await drainStdin();
  process.stderr.write('x\\n');
  process.exit(1);
})();
`,
    );
    const client = new CodingAgentLlmClient(makeScriptAdapter(script), {
      maxRetries: 1,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
    });
    await expect(client.chat('sys', 'user')).rejects.toThrow(/exited with code 1/);
  });

  it('kills the process on timeout', async () => {
    const script = writeAgentScript(
      tmpDir,
      'slow-agent',
      `${agentPreamble()}
(async () => {
  await drainStdin();
  await new Promise((r) => setTimeout(r, 10_000));
})();
`,
    );
    const client = new CodingAgentLlmClient(makeScriptAdapter(script), {
      timeoutMs: 300,
      maxRetries: 0,
    });
    await expect(client.chat('sys', 'user')).rejects.toThrow(/timed out/);
  });

  it('retries after a timeout and succeeds on a later attempt', async () => {
    const script = writeAgentScript(
      tmpDir,
      'slow-then-fast',
      `${agentPreamble()}
(async () => {
  await drainStdin();
  const counter = ${JSON.stringify(path.join(tmpDir, 'count-timeout'))};
  let n = 0;
  try { n = parseInt(fs.readFileSync(counter, 'utf8').trim(), 10) || 0; } catch {}
  n += 1;
  fs.writeFileSync(counter, String(n));
  if (n < 2) await new Promise((r) => setTimeout(r, 10_000));
  process.stdout.write('fast response\\n');
})();
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
    expect(fs.readFileSync(path.join(tmpDir, 'count-timeout'), 'utf-8').trim()).toBe('2');
  });

  it('kills the call when output exceeds the cap', async () => {
    const script = writeAgentScript(
      tmpDir,
      'flooding-agent',
      `${agentPreamble()}
(async () => {
  await drainStdin();
  const counter = ${JSON.stringify(path.join(tmpDir, 'count-cap'))};
  let n = 0;
  try { n = parseInt(fs.readFileSync(counter, 'utf8').trim(), 10) || 0; } catch {}
  n += 1;
  fs.writeFileSync(counter, String(n));
  process.stdout.write('x'.repeat(10_000));
})();
`,
    );
    const client = new CodingAgentLlmClient(makeScriptAdapter(script), {
      maxOutputChars: 64,
      maxRetries: 2,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
    });
    await expect(client.chat('sys', 'user')).rejects.toThrow(/exceeded the 64-char stdout limit/);
    // exitCode null ? terminal per the adapters ? no retry
    expect(fs.readFileSync(path.join(tmpDir, 'count-cap'), 'utf-8').trim()).toBe('1');
  });

  it('throws terminal when the binary does not exist (ENOENT)', async () => {
    const adapter = makeScriptAdapter(path.join(tmpDir, 'no-such-binary'));
    const client = new CodingAgentLlmClient(adapter, { maxRetries: 2, retryBaseDelayMs: 1 });
    await expect(client.chat('sys', 'user')).rejects.toThrow(/Failed to spawn/);
  });

  it('chatJson parses fenced JSON output', async () => {
    const script = writeAgentScript(
      tmpDir,
      'json-agent',
      `${agentPreamble()}
(async () => {
  await drainStdin();
  process.stdout.write('Here is the result:\\n\`\`\`json\\n{"action":"UPDATE"}\\n\`\`\`\\n');
})();
`,
    );
    const client = new CodingAgentLlmClient(makeScriptAdapter(script));
    await expect(client.chatJson('sys', 'user')).resolves.toEqual({ action: 'UPDATE' });
  });

  it('delivers the prompt via stdin', async () => {
    const script = writeAgentScript(
      tmpDir,
      'echo-agent',
      `${agentPreamble()}
(async () => {
  const text = await drainStdin();
  process.stdout.write(text);
})();
`,
    );
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
