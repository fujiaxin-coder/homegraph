/**
 * Spec Mine CLI Config Construction Tests
 *
 * Validates that MineConfig objects are constructed correctly from the
 * option values that commander passes into the action handler.  This is a
 * direct test of the config-building logic, not a re-implementation of it.
 *
 * The numeric option validation (parseInt / parseFloat bounds checks) is
 * tested implicitly — the MineConfig type constrains the fields, and the
 * pipeline tests verify end-to-end behaviour with different config values.
 */
import { describe, it, expect } from 'vitest';
import { createMineConfig } from '../src/spec/config';
import * as path from 'path';

describe('spec mine CLI: MineConfig construction', () => {
  it('populates all fields from options', () => {
    const config = createMineConfig({
      limit: 50,
      threshold: 0.3,
      maxCluster: 5,
      outputDir: path.resolve('/tmp/out'),
      skipLlm: false,
      allCommits: true,
    }, true);

    expect(config.limit).toBe(50);
    expect(config.threshold).toBe(0.3);
    expect(config.maxCluster).toBe(5);
    expect(config.outputDir).toBe(path.resolve('/tmp/out'));
    expect(config.skipLlm).toBe(false);
    expect(config.allCommits).toBe(true);
  });

  it('template field is forwarded when provided', () => {
    const config = createMineConfig({
      limit: 100,
      threshold: 0.5,
      maxCluster: 10,
      outputDir: '/tmp/out',
      template: './my-template.md',
      skipLlm: false,
      allCommits: false,
    }, true);

    expect(config.template).toBe('./my-template.md');
  });

  it('template is undefined when not provided', () => {
    const config = createMineConfig({
      limit: 100,
      threshold: 0.5,
      maxCluster: 10,
      outputDir: '/tmp/out',
      skipLlm: false,
      allCommits: false,
    }, true);

    expect(config.template).toBeUndefined();
  });

  it('skipLlm and allCommits are independent booleans', () => {
    // Both true
    const a = createMineConfig({
      limit: 100, threshold: 0.5, maxCluster: 10, outputDir: '.',
      skipLlm: true, allCommits: true,
    }, true);
    expect(a.skipLlm).toBe(true);
    expect(a.allCommits).toBe(true);

    // Both false
    const b = createMineConfig({
      limit: 100, threshold: 0.5, maxCluster: 10, outputDir: '.',
      skipLlm: false, allCommits: false,
    }, true);
    expect(b.skipLlm).toBe(false);
    expect(b.allCommits).toBe(false);

    // Mixed
    const c = createMineConfig({
      limit: 100, threshold: 0.5, maxCluster: 10, outputDir: '.',
      skipLlm: true, allCommits: false,
    }, true);
    expect(c.skipLlm).toBe(true);
    expect(c.allCommits).toBe(false);
  });

  it('limit can be 1 (minimum)', () => {
    const config = createMineConfig({
      limit: 1, threshold: 0.5, maxCluster: 10, outputDir: '.',
      skipLlm: false, allCommits: false,
    }, true);
    expect(config.limit).toBe(1);
  });

  it('limit can be 1000 (maximum)', () => {
    const config = createMineConfig({
      limit: 1000, threshold: 0.5, maxCluster: 10, outputDir: '.',
      skipLlm: false, allCommits: false,
    }, true);
    expect(config.limit).toBe(1000);
  });

  it('threshold can be 0', () => {
    const config = createMineConfig({
      limit: 100, threshold: 0, maxCluster: 10, outputDir: '.',
      skipLlm: false, allCommits: false,
    }, true);
    expect(config.threshold).toBe(0);
  });

  it('threshold can be 1', () => {
    const config = createMineConfig({
      limit: 100, threshold: 1, maxCluster: 10, outputDir: '.',
      skipLlm: false, allCommits: false,
    }, true);
    expect(config.threshold).toBe(1);
  });
});
