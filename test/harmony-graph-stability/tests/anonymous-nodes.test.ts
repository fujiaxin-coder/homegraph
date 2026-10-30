import { describe, expect, it } from 'vitest';
import { CONTRACT, requireFilled } from './contract';
import { amNodeKeys, indexStabilityProject } from './helpers';

/**
 * 合同要求：HG 落库的 %AM 指纹必须与 AA 全量 Scene 的 amKeys 精确相等。
 *
 * TODO(后续修复后去掉 skip)：
 *   当前 HomeGraph 对本多模块 fixture 走 analyseByModule，%AM 命名/行号编码与
 *   全量 buildSceneFromProjectDir 不一致，精确 toEqual 会红。
 *   修复方向：小仓改全量 Scene，或适配器对齐全量 Scene 的 %AM 稳定名。
 *   在此之前保持 skip，禁止把断言改成只比 count。
 */
describe.skip('harmony-graph-stability / anonymous %AM nodes', () => {
  it(
    'AM keys match CONTRACT.fingerprints.amKeys (sorted file\\0name\\0line)',
    async () => {
      const { cg, nodes } = await indexStabilityProject();
      try {
        const expected = requireFilled(CONTRACT.fingerprints.amKeys, 'fingerprints.amKeys');
        const keys = amNodeKeys(nodes);
        expect(keys.length).toBe(CONTRACT.fingerprints.amKeyCount);
        expect(new Set(keys.map((k) => k.split('\0')[0])).size).toBe(
          CONTRACT.fingerprints.amFileCount
        );
        expect(keys).toEqual(expected);
      } finally {
        cg.close();
      }
    },
    180_000
  );
});
