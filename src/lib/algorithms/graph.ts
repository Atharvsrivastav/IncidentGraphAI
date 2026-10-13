import {
  CycleDetectionResult,
  EdgeMetadata,
  GraphValidationResult,
  ServiceNodeData,
  TraversalStep,
} from "./types";

/**
 * Directed Adjacency-List Graph
 *
 * Edge Convention:
 * A -> B denotes that Service A calls or depends on Service B.
 *
 * Space Complexity: O(V + E)
 */
export class DirectedGraph<T = ServiceNodeData, E = EdgeMetadata> {
  private nodes: Map<string, T> = new Map();
  // forwardEdges: source -> Map<target, metadata> (A depends on B)
  private forwardEdges: Map<string, Map<string, E>> = new Map();
  // reverseEdges: target -> Map<source, metadata> (B is depended upon by A)
  private reverseEdges: Map<string, Map<string, E>> = new Map();

  public addNode(id: string, data: T): void {
    this.nodes.set(id, data);
    if (!this.forwardEdges.has(id)) {
      this.forwardEdges.set(id, new Map());
    }
    if (!this.reverseEdges.has(id)) {
      this.reverseEdges.set(id, new Map());
    }
  }

  public getNode(id: string): T | undefined {
    return this.nodes.get(id);
  }

  public getAllNodes(): [string, T][] {
    return Array.from(this.nodes.entries());
  }

  public getAllNodeIds(): string[] {
    return Array.from(this.nodes.keys());
  }

  public hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  public removeNode(id: string): boolean {
    if (!this.nodes.has(id)) return false;

    // Remove all forward edges from this node
    const outgoing = this.forwardEdges.get(id);
    if (outgoing) {
      for (const targetId of outgoing.keys()) {
        this.reverseEdges.get(targetId)?.delete(id);
      }
    }
    this.forwardEdges.delete(id);

    // Remove all reverse edges pointing to this node
    const incoming = this.reverseEdges.get(id);
    if (incoming) {
      for (const sourceId of incoming.keys()) {
        this.forwardEdges.get(sourceId)?.delete(id);
      }
    }
    this.reverseEdges.delete(id);

    return this.nodes.delete(id);
  }

  public addEdge(from: string, to: string, metadata?: E): void {
    if (!this.nodes.has(from) || !this.nodes.has(to)) {
      throw new Error(`Cannot add edge: Nodes '${from}' and/or '${to}' do not exist.`);
    }

    if (!this.forwardEdges.has(from)) {
      this.forwardEdges.set(from, new Map());
    }
    if (!this.reverseEdges.has(to)) {
      this.reverseEdges.set(to, new Map());
    }

    const meta = metadata ?? ({} as E);
    this.forwardEdges.get(from)!.set(to, meta);
    this.reverseEdges.get(to)!.set(from, meta);
  }

  public removeEdge(from: string, to: string): boolean {
    const fMap = this.forwardEdges.get(from);
    const rMap = this.reverseEdges.get(to);

    const fDeleted = fMap?.delete(to) ?? false;
    const rDeleted = rMap?.delete(from) ?? false;

    return fDeleted || rDeleted;
  }

  public hasEdge(from: string, to: string): boolean {
    return this.forwardEdges.get(from)?.has(to) ?? false;
  }

  public getEdgeMetadata(from: string, to: string): E | undefined {
    return this.forwardEdges.get(from)?.get(to);
  }

  /**
   * Retrieves services that `id` calls / depends on (outgoing edges).
   * Complexity: O(deg+(v))
   */
  public getDependencies(id: string): string[] {
    const edgeMap = this.forwardEdges.get(id);
    return edgeMap ? Array.from(edgeMap.keys()) : [];
  }

  /**
   * Retrieves services that call / depend on `id` (incoming edges).
   * Complexity: O(deg-(v))
   */
  public getDependents(id: string): string[] {
    const edgeMap = this.reverseEdges.get(id);
    return edgeMap ? Array.from(edgeMap.keys()) : [];
  }

  /**
   * BFS: Incident Impact Propagation
   * Since edge A -> B means A depends on B, if B fails, the impact
   * propagates upwards to its dependents (along reverse edges).
   *
   * Complexity: O(V + E)
   */
  public findImpactedDependents(originServiceId: string): TraversalStep[] {
    if (!this.nodes.has(originServiceId)) {
      return [];
    }

    const visited = new Set<string>();
    const queue: { id: string; depth: number; path: string[] }[] = [];
    const result: TraversalStep[] = [];

    visited.add(originServiceId);
    queue.push({ id: originServiceId, depth: 0, path: [originServiceId] });

    while (queue.length > 0) {
      const current = queue.shift()!;

      // Retrieve all services that depend on current node (reverse edges)
      const dependents = this.getDependents(current.id);
      // Sort alphabetically for deterministic traversal
      dependents.sort();

      for (const dependentId of dependents) {
        if (!visited.has(dependentId)) {
          visited.add(dependentId);
          const nextDepth = current.depth + 1;
          const nextPath = [...current.path, dependentId];
          const edgeMeta = this.forwardEdges.get(dependentId)?.get(current.id) as EdgeMetadata | undefined;

          const reason = edgeMeta?.dependencyType
            ? `Cascading failure via ${edgeMeta.dependencyType} dependency (depth ${nextDepth})`
            : `Downstream dependent affected at depth ${nextDepth}`;

          const step: TraversalStep = {
            serviceId: dependentId,
            depth: nextDepth,
            path: nextPath,
            reason,
          };

          result.push(step);
          queue.push({ id: dependentId, depth: nextDepth, path: nextPath });
        }
      }
    }

    return result;
  }

  /**
   * DFS: Finds all downstream reachable services (outgoing dependency chain).
   * Complexity: O(V + E)
   */
  public getReachableServices(startId: string): string[] {
    if (!this.nodes.has(startId)) return [];

    const visited = new Set<string>();
    const result: string[] = [];

    const dfs = (curr: string) => {
      visited.add(curr);
      const dependencies = this.getDependencies(curr);
      dependencies.sort();

      for (const dep of dependencies) {
        if (!visited.has(dep)) {
          result.push(dep);
          dfs(dep);
        }
      }
    };

    dfs(startId);
    return result;
  }

  /**
   * Cycle Detection using 3-Color DFS
   * 0: WHITE (unvisited)
   * 1: GRAY (currently visiting in recursion stack)
   * 2: BLACK (visited and backtrack completed)
   *
   * Complexity: O(V + E)
   */
  public findCycles(): CycleDetectionResult {
    const color = new Map<string, number>();
    const parent = new Map<string, string | null>();
    const cycles: string[][] = [];

    for (const nodeId of this.nodes.keys()) {
      color.set(nodeId, 0); // WHITE
      parent.set(nodeId, null);
    }

    const dfsVisit = (u: string, currentPath: string[]) => {
      color.set(u, 1); // GRAY
      const neighbors = this.getDependencies(u);

      for (const v of neighbors) {
        if (color.get(v) === 1) {
          // Detected cycle from v to u
          const cycleStartIdx = currentPath.indexOf(v);
          if (cycleStartIdx !== -1) {
            const detectedCycle = [...currentPath.slice(cycleStartIdx), v];
            cycles.push(detectedCycle);
          } else {
            cycles.push([v, u, v]);
          }
        } else if (color.get(v) === 0) {
          parent.set(v, u);
          dfsVisit(v, [...currentPath, v]);
        }
      }

      color.set(u, 2); // BLACK
    };

    for (const nodeId of this.nodes.keys()) {
      if (color.get(nodeId) === 0) {
        dfsVisit(nodeId, [nodeId]);
      }
    }

    return {
      hasCycle: cycles.length > 0,
      cycles,
    };
  }

  public hasCycle(): boolean {
    return this.findCycles().hasCycle;
  }

  /**
   * Graph Integrity Validation
   */
  public validateGraphIntegrity(): GraphValidationResult {
    const errors: string[] = [];
    let edgeCount = 0;

    for (const [from, targets] of this.forwardEdges.entries()) {
      if (!this.nodes.has(from)) {
        errors.push(`Orphan source node '${from}' found in forward edges.`);
      }
      for (const to of targets.keys()) {
        edgeCount++;
        if (!this.nodes.has(to)) {
          errors.push(`Dangling edge: '${from}' -> '${to}' references non-existent target.`);
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      nodeCount: this.nodes.size,
      edgeCount,
    };
  }
}
