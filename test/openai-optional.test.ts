import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { OpenAiLlmClient } from '../src/spec/llm/client';
import { OPENAI_INSTALL_HINT, loadOpenAI } from '../src/spec/llm/openai-sdk';

describe('optional openai (Spec 0031)', () => {
  it('is listed under optionalDependencies, not dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    expect(pkg.dependencies.openai).toBeUndefined();
    expect(pkg.optionalDependencies.openai).toBeDefined();
    expect(pkg.dependencies['tree-sitter-wasms']).toBeDefined();
  });

  it('OpenAiLlmClient can be constructed without calling into openai', () => {
    const client = new OpenAiLlmClient({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test',
      temperature: 0,
      maxTokens: 16,
      maxRetries: 0,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    });
    expect(client).toBeInstanceOf(OpenAiLlmClient);
  });

  it('loadOpenAI surfaces an install hint on MODULE_NOT_FOUND', () => {
    try {
      loadOpenAI();
    } catch (err) {
      expect((err as Error).message).toBe(OPENAI_INSTALL_HINT);
      return;
    }
    // Package is present in this workspace (optional dep still installed by default).
    expect(loadOpenAI()).toBeTypeOf('function');
  });
});
