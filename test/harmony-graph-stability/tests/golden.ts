/**
 * Locked counts for `project/` after a full index (absolute equality).
 * Captured 2026-10-29 on local Windows + arkanalyzer 1.0.94.
 */
export const GOLDEN = {
  etsFileNodes: 25,
  minAnonymousNodes: 1,
  minViewTreeEdges: 1,
  minImportEdges: 1,
  minExtendsOrImplements: 1,
  nodes: 231,
  edges: 358,
  nodesByKind: {
    file: 26, // 25 .ets + @dummyFile
    interface: 5,
    method: 95,
    class: 11,
    struct: 10,
    component: 10,
    property: 10,
    function: 40,
    import: 24,
  } as Record<string, number>,
  edgesByKind: {
    contains: 205,
    calls: 89,
    implements: 5,
    references: 30,
    extends: 5,
    imports: 24,
  } as Record<string, number>,
};
