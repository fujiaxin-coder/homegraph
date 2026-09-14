/**
 * Lazy load of the optional `openai` package (Spec 0031).
 *
 * MCP `serve mcp` must start without it. Spec LLM commands require
 * `npm install openai`.
 *
 * @module spec/llm/openai-sdk
 */

export const OPENAI_INSTALL_HINT =
  'The openai package is not installed. Spec LLM calls need it: npm install openai';

/** Default export of `openai` — the client constructor plus `RateLimitError` etc. */
export type OpenAIClientCtor = typeof import('openai').default;

export function loadOpenAI(): OpenAIClientCtor {
  try {
    // Optional dependency: not a static import so `serve mcp` loads without it.
    const mod = require('openai') as { default?: OpenAIClientCtor } & OpenAIClientCtor;
    return (mod.default ?? mod) as OpenAIClientCtor;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'MODULE_NOT_FOUND') {
      throw new Error(OPENAI_INSTALL_HINT);
    }
    throw err;
  }
}

export function tryLoadOpenAI(): OpenAIClientCtor | undefined {
  try {
    return loadOpenAI();
  } catch {
    return undefined;
  }
}
