// /capabilities/internal/graph.ts
// Capability dependency graph (architecture §2.2, §6, WORK-005 §9, §10, §17).
//
// The graph is DIRECTED and SEMANTIC: an edge (A, vA) → (B, vB) means
// "Capability A at version vA requires Capability B at version vB." It does
// NOT describe provider topology ("Provider X calls Provider Y" belongs to
// later provider/strategy layers — WORK-005 §10).
//
// Graph requirements (WORK-005 §9, §17):
//   - directed graph
//   - stable capability references
//   - cycle detection (a malformed graph must fail deterministically before
//     downstream systems consume it)
//   - deterministic traversal
//   - dependency validation (missing / self / duplicate / retired-status)
//   - version-aware references where required
//
// This module is PURE: it operates on resolved edge lists passed in by the
// service (which loads edges from PostgreSQL and resolves NULL version pins
// to each target's current active version). Keeping it pure makes the cycle
// detection deterministic and unit-testable without a database.

// A graph node is a (capability_id, version) pair — the stable, version-aware
// reference. Serialized as `${capability_id}@${version}` for set operations.
export type GraphNode = string;

export function nodeKey(capabilityId: string, version: string): GraphNode {
  return `${capabilityId}@${version}`;
}

export interface GraphEdge {
  from: GraphNode;
  to: GraphNode;
}

export interface CycleResult {
  /** true iff a cycle is reachable from `start` back to `start`. */
  hasCycle: boolean;
  /** The offending path (start included at both ends) when hasCycle, else []. */
  path: GraphNode[];
}

/**
 * Detect whether adding the candidate edge creates a cycle. The candidate
 * edge is `start → candidateTarget`. A cycle exists iff, starting from
 * `candidateTarget` and following `existing` edges, we reach `start` again.
 *
 * DFS with a visited set + a current-path stack so we can return the offending
 * cycle path for explainability (WORK-005 §17: "A valid graph must have
 * deterministic traversal/output" and failures must be explainable).
 */
export function detectCycle(
  existing: readonly GraphEdge[],
  start: GraphNode,
  candidateTarget: GraphNode,
): CycleResult {
  // Build adjacency from the existing edges for O(V+E) traversal.
  const adj = new Map<GraphNode, GraphNode[]>();
  for (const e of existing) {
    const arr = adj.get(e.from);
    if (arr) arr.push(e.to);
    else adj.set(e.from, [e.to]);
  }

  // Self-cycle: start === candidateTarget means the candidate edge is
  // start → start (a capability depending on itself at the same node). The
  // service rejects self-dependencies separately (before calling here), but
  // guard anyway.
  if (start === candidateTarget) {
    return { hasCycle: true, path: [start, candidateTarget] };
  }

  // DFS from candidateTarget; if we reach `start`, the candidate edge
  // start→candidateTarget plus candidateTarget→...→start forms a cycle.
  const visited = new Set<GraphNode>();
  const pathStack: GraphNode[] = [candidateTarget];
  let found: GraphNode[] | null = null;

  function dfs(node: GraphNode): boolean {
    if (node === start) {
      found = [...pathStack, start];
      return true;
    }
    if (visited.has(node)) return false;
    visited.add(node);
    const neighbors = adj.get(node);
    if (neighbors) {
      for (const nb of neighbors) {
        pathStack.push(nb);
        if (dfs(nb)) return true;
        pathStack.pop();
      }
    }
    return false;
  }

  const hasCycle = dfs(candidateTarget);
  return { hasCycle, path: hasCycle && found ? found : [] };
}

/**
 * Deterministic topological-ish traversal of the graph (WORK-005 §17:
 * "deterministic traversal"). Returns nodes grouped by depth (root
// dependencies first), with ties broken alphabetically for determinism.
 * Used by the graph-inspection endpoint so a human/operator sees a stable
 * ordering regardless of insertion order.
 */
export function topologicalOrder(
  edges: readonly GraphEdge[],
): { levels: GraphNode[][]; order: GraphNode[] } {
  const nodes = new Set<GraphNode>();
  for (const e of edges) {
    nodes.add(e.from);
    nodes.add(e.to);
  }

  const levels: GraphNode[][] = [];
  const remaining = new Set(nodes);
  const resolved = new Set<GraphNode>();
  while (remaining.size > 0) {
    // A node belongs to this layer if no unresolved node has an edge INTO it
    // (i.e. its unresolved in-degree is 0). Roots and already-unblocked
    // nodes surface here.
    const layer: GraphNode[] = [];
    for (const n of remaining) {
      let inDeg = 0;
      for (const e of edges) {
        if (e.to === n && !resolved.has(e.from)) inDeg++;
      }
      if (inDeg === 0) layer.push(n);
    }
    if (layer.length === 0) {
      // Remaining nodes are all part of (or downstream of) a cycle. Emit
      // them alphabetically so the traversal still terminates deterministically
      // rather than looping forever on a cyclic graph.
      const leftover = [...remaining].sort();
      levels.push(leftover);
      break;
    }
    layer.sort();
    levels.push(layer);
    for (const n of layer) {
      resolved.add(n);
      remaining.delete(n);
    }
  }
  const order = levels.flat();
  return { levels, order };
}

/**
 * Find all nodes reachable from `start` following `edges` (forward
 * traversal). Used to describe the transitive dependency set of a capability
 * version for the graph endpoint.
 */
export function reachableFrom(
  edges: readonly GraphEdge[],
  start: GraphNode,
): GraphNode[] {
  const adj = new Map<GraphNode, GraphNode[]>();
  for (const e of edges) {
    const arr = adj.get(e.from);
    if (arr) arr.push(e.to);
    else adj.set(e.from, [e.to]);
  }
  const visited = new Set<GraphNode>();
  const stack = [start];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (visited.has(n)) continue;
    visited.add(n);
    const neighbors = adj.get(n);
    if (neighbors) {
      for (const nb of neighbors) {
        if (!visited.has(nb)) stack.push(nb);
      }
    }
  }
  visited.delete(start);
  return [...visited].sort();
}
