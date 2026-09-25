import { describe, expect, it } from 'vitest';
import { AssetSeriesGraph } from './asset-series.js';

describe('asset series graph', () => {
  it('merges explicit links transitively while preserving branches and ignoring foreign nodes', () => {
    const graph = new AssetSeriesGraph([
      { node: 'a:one', parent: null }, { node: 'j:edit', parent: 'a:one' },
      { node: 'a:output', parent: 'j:edit' }, { node: 'a:two', parent: null },
      { node: 'a:three', parent: null }, { node: 'a:unrelated', parent: null },
    ], [{ node: 'a:output', linked: 'a:two' }, { node: 'a:three', linked: 'a:two' }, { node: 'a:two', linked: 'a:output' }, { node: 'a:unrelated', linked: 'foreign' }]);
    expect(new Set(graph.family('a:three').nodes)).toEqual(new Set(['a:one', 'j:edit', 'a:output', 'a:two', 'a:three']));
    expect(graph.roots.get('a:three')).toBe(graph.roots.get('a:one'));
    expect(graph.family('a:unrelated').nodes).toEqual(['a:unrelated']);
  });
  it('resolves deep chains iteratively and bounds the visible family', () => {
    const graph = new AssetSeriesGraph(Array.from({ length: 20_000 }, (_, i) => ({ node: `a:${i}`, parent: i === 0 ? null : `a:${i - 1}` })).reverse());
    expect(graph.roots.size).toBe(20_000);
    expect(graph.roots.get('a:19999')).toBe('a:0');
    expect(graph.family('a:19999')).toMatchObject({ truncated: true });
    expect(graph.family('a:19999').nodes).toHaveLength(1000);
  });
  it('keeps roots canonical for cycles, branches, isolated and missing-parent nodes', () => {
    const graph = new AssetSeriesGraph([
      { node: 'a:branch-before-cycle', parent: 'j:cycle' },
      { node: 'j:cycle', parent: 'a:cycle' },
      { node: 'a:cycle', parent: 'j:cycle' },
      { node: 'a:another-branch', parent: 'a:cycle' },
      { node: 'a:isolated', parent: null },
      { node: 'a:missing', parent: 'foreign-node' },
    ]);
    for (const node of ['a:branch-before-cycle', 'j:cycle', 'a:cycle', 'a:another-branch']) expect(graph.roots.get(node)).toBe('a:cycle');
    expect(graph.roots.get('a:missing')).toBe('a:missing');
    expect(graph.family('a:isolated')).toEqual({ nodes: ['a:isolated'], truncated: false });
    expect(graph.family('foreign-node')).toEqual({ nodes: [], truncated: false });
    expect(graph.family('a:cycle').nodes).toHaveLength(4);
  });
});
