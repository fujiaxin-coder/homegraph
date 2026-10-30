/**
 * Locked counts for `project/` — **source + indexing-rule priors only**.
 * Template: 5 modules × (Page, Child, Lib, Base, Util). No “match Received”.
 *
 * --- imports (edges) ---
 * Page: Child + runLib + helper → 3×5 = 15
 * Lib: Base → 1×5 = 5
 * Util: helper↑ only on B–E → 4
 * total **24**
 *
 * --- heritage ---
 * Worker extends Base → **5**; Base implements IFace → **5**
 *
 * --- %AM keys (file\\0name\\0line), source lambdas only ---
 * Page: aboutToAppear λ, onClick λ → 2
 * Child: onClick λ → 1
 * Lib: forEach λ, nested touch λ, runLib λ → 3
 * Util: helper `wrap` λ, mapAll map λ → 2
 * ×5 → **40** (does **not** count AA line-1 %AM shells absent from source)
 * Files with those λ: Page/Child/Lib/Util → **20**
 *
 * --- viewtree edges (synthesizedBy=viewtree), rules in indexViewTreeForClass ---
 * Per module when Page VT runs:
 *   1 @State count → build (state-binding)
 *   2 Page.build → Child (child-component)
 *   3 Page.build → Page onClick AM (onClick)
 *   4 Page.build → Child onClick AM (nested walk into Child subtree)
 *   5 Prop passage → Child.label (via Prop / data-passage)
 * When Child VT runs:
 *   6 @Prop label → build (state-binding)
 *   7 Child.build → Child onClick AM (onClick)
 * ×5 → **35**
 *
 * --- files ---
 * 5×5 .ets = **25** (+ @dummyFile → file kind 26)
 *
 * --- graph totals / by-kind ---
 * Below: structural inventory under the same template (struct/component Page+Child,
 * class Worker+Base, interface IFace, property State+Prop, import=24, …).
 * method/function/contains/calls mixes named + %AM + AA constructors — kept as
 * the fixture contract counts enumerated with that inventory (not soft mins).
 */
export const GOLDEN = {
  etsFileNodes: 25,
  anonymousNodes: 40,
  anonymousFiles: 20,
  viewtreeEdges: 35,
  importEdges: 24,
  extendsEdges: 5,
  implementsEdges: 5,
  // Totals/by-kind: only kinds fixed by the priors above are authoritative here.
  // contains/calls/method/function still need a full AA constructor/%AM inventory;
  // do not treat them as soft “>=1” — leave explicit and expect graph-totals to
  // fail until that inventory is finished (prefer fail over fake match).
  nodes: 231,
  edges: 363, // contains205+calls89+implements5+references35+extends5+imports24
  nodesByKind: {
    file: 26, // 25 .ets + @dummyFile
    interface: 5,
    method: 95, // TODO: re-enumerate with source λ=40 only (no AA shells)
    class: 11, // Worker+Base×5 + AA dummy class
    struct: 10, // Page+Child ×5
    component: 10,
    property: 10, // @State + @Prop ×5
    function: 40, // TODO: same as method — pin after AM inventory
    import: 24,
  } as Record<string, number>,
  edgesByKind: {
    contains: 205, // TODO: re-enumerate contains
    calls: 89, // TODO: re-enumerate calls
    implements: 5,
    references: 35, // = viewtreeEdges prior (this fixture: all references are viewtree)
    extends: 5,
    imports: 24,
  } as Record<string, number>,
};
