# Data Structures & Algorithms (DSA) Showcase in IncidentGraph AI

IncidentGraph AI solves core Site Reliability Engineering (SRE) incident investigation challenges using rigorous, deterministic data structures and algorithms.

In this system, DSA is not a theoretical demonstration—every data structure and algorithm was intentionally chosen to solve a concrete distributed-systems problem and directly powers the real-time root-cause detection pipeline.

---

## Architectural Principle: Deterministic DSA vs. AI vs. Telemetry

| Layer | Responsibility | Mechanism | Why Chosen Over Alternatives |
| :--- | :--- | :--- | :--- |
| **Telemetry Ingestion** | Signal collection & context propagation | W3C `traceparent`, OpenTelemetry SDK, Prometheus, Tempo | Industry standard for non-intrusive distributed trace and metric collection across process boundaries. |
| **Deterministic DSA Engine** | Topological analysis, blast radius, anomaly correlation, candidate ranking | Directed graphs, BFS, DFS 3-coloring, Binary Max-Heap, Sliding Windows | **100% deterministic, non-generative, $O(V + E)$ predictable latency.** Does not guess causal links; computes them from graph reachability and temporal ordering. |
| **AI / Synthesis Layer** | Natural-language explanation & remediation playbooks | Structured prompt synthesis, context grounding | Translates mathematically proven top-$K$ candidates and span metrics into human-readable runbooks for on-call engineers. |

---

## 1. Directed Adjacency-List Graph (`DirectedGraph<T, E>`)

- **Implementation:** [`src/lib/algorithms/graph.ts`](file:///c:/Users/Atharv/Desktop/IncidentGrapghAI/src/lib/algorithms/graph.ts)
- **Role:** In-memory representation of distributed service architecture and directional dependencies.

### 1.1 Problem Solved
Distributed applications consist of caller-callee relationships (e.g., `API Gateway` calls `Order Service`, which calls `PostgreSQL`). To analyze fault propagation, the system must traverse dependencies bidirectionally:
- **Forward:** Whom does Service A depend upon?
- **Reverse:** Who depends on Service B (who will be impacted if B degrades)?

### 1.2 Why Selected
An adjacency-list representation using hash maps (`Map<string, Map<string, E>>`) was chosen over an adjacency matrix because microservice graphs are sparse ($E \ll V^2$). Space complexity is strictly $O(V + E)$ rather than $O(V^2)$, and looking up adjacent edges takes $O(1)$ amortized time.

### 1.3 Inputs & Outputs
- **Inputs:** Vertex ID and arbitrary node metadata $T$; directed edge $(u, v)$ with edge metadata $E$.
- **Outputs:** Arrays of dependent or dependency node IDs and edge properties.

### 1.4 Complexity Analysis
| Operation | Time Complexity | Space Complexity | Justification |
| :--- | :--- | :--- | :--- |
| `addNode(id, data)` | $O(1)$ amortized | $O(1)$ | Hash map insert |
| `addEdge(from, to, meta)` | $O(1)$ amortized | $O(1)$ | Nested map insert for both forward and reverse lists |
| `getDependencies(id)` | $O(\text{deg}^+(v))$ | $O(\text{deg}^+(v))$ | Iterates over forward outgoing map |
| `getDependents(id)` | $O(\text{deg}^-(v))$ | $O(\text{deg}^-(v))$ | Iterates over reverse incoming map |
| **Total Graph Storage** | — | $O(V + E)$ | Two adjacency lists storing $V$ vertices and $2E$ references |

### 1.5 Practical Example in IncidentGraph AI
```typescript
// Edge convention: from caller (consumer) to callee (provider)
graph.addEdge("api-gateway", "order-service", { type: "HTTP_REST", timeoutMs: 3000 });
graph.addEdge("order-service", "postgres-db", { type: "TCP_DATABASE", timeoutMs: 5000 });

// If postgres-db fails, find its immediate callers:
const callers = graph.getDependents("postgres-db"); // ['order-service']
```

---

## 2. Reverse Breadth-First Search (BFS) for Impact Propagation

- **Implementation:** [`src/lib/algorithms/graph.ts#findImpactedDependents`](file:///c:/Users/Atharv/Desktop/IncidentGrapghAI/src/lib/algorithms/graph.ts)
- **Role:** Traces the blast radius and cascading degradation path when an origin service fails.

### 2.1 Problem Solved
When a deep leaf dependency (such as `postgres-db`) experiences latency, that delay cascades upward through intermediate callers (`order-service`) to external user gateways (`api-gateway`). SREs must know the complete blast radius, the depth of each impacted caller, and the path through which the failure propagated.

### 2.2 Why Selected
BFS explores level-by-level using a FIFO queue. This guarantees that the discovered distance (`depth`) from the failure origin to each impacted service is the **shortest causal path**. DFS would not guarantee shortest path without exploring all permutations.

### 2.3 Inputs & Outputs
- **Input:** Origin service identifier (e.g., `"postgres-db"`).
- **Output:** Array of `TraversalStep` objects: `{ nodeId, depth, path, visitedOrder }`.

### 2.4 Complexity Analysis
- **Time Complexity:** $O(V + E)$ — Every reachable vertex and edge is visited at most once.
- **Space Complexity:** $O(V)$ — Visited set and FIFO queue store at most $V$ elements.

### 2.5 Practical Example in IncidentGraph AI
```typescript
const blastRadius = graph.findImpactedDependents("postgres-db");
// Output:
// [
//   { nodeId: "order-service", depth: 1, path: ["postgres-db", "order-service"] },
//   { nodeId: "api-gateway", depth: 2, path: ["postgres-db", "order-service", "api-gateway"] }
// ]
```

---

## 3. Depth-First Search (DFS) & 3-Color Cycle Detection

- **Implementation:** [`src/lib/algorithms/graph.ts#findCycles`](file:///c:/Users/Atharv/Desktop/IncidentGrapghAI/src/lib/algorithms/graph.ts)
- **Role:** Audits microservice architecture to prevent circular dependency deadlocks and infinite cascading loops.

### 3.1 Problem Solved
Circular dependencies (e.g., Service A $\rightarrow$ Service B $\rightarrow$ Service C $\rightarrow$ Service A) create catastrophic failure modes: distributed deadlocks, exponential retry storms, and unresolvable cascading crashes. Topologies must be validated as Directed Acyclic Graphs (DAGs).

### 3.2 Why Selected
The **White/Gray/Black 3-color DFS state model** efficiently differentiates between:
- Tree edges (exploring forward)
- Cross/Forward edges (already fully explored subtrees — **Black**)
- **Back edges** (pointing to an active ancestor in the current recursion call stack — **Gray**)

Encountering a **Gray** vertex definitively proves a directed cycle in a single pass.

### 3.3 Inputs & Outputs
- **Input:** Directed graph instance.
- **Output:** `CycleDetectionResult` `{ hasCycles: boolean, cycles: string[][] }`.

### 3.4 Complexity Analysis
- **Time Complexity:** $O(V + E)$ — Standard DFS visiting each vertex and edge once.
- **Space Complexity:** $O(V)$ — Recursion call stack and color state hash map.

### 3.5 Practical Example in IncidentGraph AI
```typescript
const result = graph.findCycles();
if (result.hasCycles) {
  console.warn("Circular dependency detected:", result.cycles[0].join(" -> "));
  // e.g. "order-service -> payment-service -> inventory-service -> order-service"
}
```

---

## 4. Binary Max-Heap & Priority Queue (`PriorityQueue<T>`)

- **Implementation:** [`src/lib/algorithms/priorityQueue.ts`](file:///c:/Users/Atharv/Desktop/IncidentGrapghAI/src/lib/algorithms/priorityQueue.ts)
- **Role:** Prioritizes root-cause candidate evaluation and extracts top-$K$ most probable failure causes in strictly descending heuristic score order.

### 4.1 Problem Solved
During widespread cascading outages, dozens of microservices trigger latency or error alarms simultaneously. The SRE team cannot investigate 30 alerts at once; they need the top 3 most likely root causes instantly.

### 4.2 Why Selected
Sorting an array of all $N$ candidates takes $O(N \log N)$. In large topologies, maintaining a complete array sort is wasteful. A Binary Max-Heap allows $O(\log N)$ inserts and extracts the top $K$ candidates in $O(K \log N)$ time. It also avoids array shifting overhead ($O(N)$) present in naive list queues.

### 4.3 Mathematical Tree Invariant
Array-indexed complete binary tree:
- Parent of index $i$: $\lfloor \frac{i - 1}{2} \rfloor$
- Left child of index $i$: $2i + 1$
- Right child of index $i$: $2i + 2$
- Max-heap property: $\text{priority}(\text{parent}) \ge \text{priority}(\text{child})$ for all non-root nodes.

### 4.4 Complexity Analysis
| Operation | Time Complexity | Space Complexity |
| :--- | :--- | :--- |
| `insert(item, priority)` | $O(\log N)$ | $O(1)$ amortized |
| `extract()` | $O(\log N)$ | $O(1)$ |
| `peek()` | $O(1)$ | $O(1)$ |
| `extractTopK(k)` | $O(K \log N)$ | $O(K)$ |
| Total Heap Storage | — | $O(N)$ |

### 4.5 Practical Example in IncidentGraph AI
```typescript
const queue = new PriorityQueue<RootCauseCandidate>();
candidates.forEach(c => queue.insert(c, c.score));

// Extract strictly the top-3 highest-ranked candidate causes:
const top3 = queue.extractTopK(3);
```

---

## 5. Sliding-Window Statistical Analyzer (`SlidingWindowAnalyzer`)

- **Implementation:** [`src/lib/algorithms/slidingWindow.ts`](file:///c:/Users/Atharv/Desktop/IncidentGrapghAI/src/lib/algorithms/slidingWindow.ts)
- **Role:** Differentiates genuine persistent degradation from transient network noise and determines the exact onset step of an incident.

### 5.1 Problem Solved
Raw telemetry is noisy: transient garbage collection pauses or minor network jitter can cause brief latency spikes. Naive threshold checks cause alert fatigue (flapping). The system must compute a smoothed moving average across recent observation steps $W$ and identify when the sustained breach began.

### 5.2 Mathematical Formulation
For a window buffer of samples $W = [s_1, s_2, \dots, s_k]$:
- Moving Average Latency: $\bar{L} = \frac{1}{|W|} \sum_{s \in W} L_s$
- Moving Average Error Rate: $\bar{E} = \frac{1}{|W|} \sum_{s \in W} E_s$
- Safe division: If $|W| = 0$, returns baseline without throwing `NaN` or zero-division errors.
- Onset Discovery: First step $t_{\text{onset}}$ where $\bar{L} \ge 2.0 \cdot L_{\text{base}}$ or $\bar{E} - E_{\text{base}} \ge 5.0\%$.

### 5.3 Complexity Analysis
- **Time Complexity:** $O(W)$ per service ($O(S \cdot W)$ across the fleet, where $W \le 10$ is the window size).
- **Space Complexity:** $O(W)$ ring buffer per service.

---

## 6. Multi-Signal Root-Cause Candidate Scoring Engine

- **Implementation:** [`src/lib/algorithms/rootCauseEngine.ts`](file:///c:/Users/Atharv/Desktop/IncidentGrapghAI/src/lib/algorithms/rootCauseEngine.ts) & [`src/lib/algorithms/realRootCauseEngine.ts`](file:///c:/Users/Atharv/Desktop/IncidentGrapghAI/src/lib/algorithms/realRootCauseEngine.ts)
- **Role:** Computes a composite confidence score $S(v) \in [0, 100]$ for every service node based purely on topological and telemetry evidence, **without peeking at the simulation scenario**.

### 6.1 Mathematical Scoring Heuristic
$$S(v) = w_{\text{depth}} \cdot C_{\text{depth}}(v) + w_{\text{onset}} \cdot C_{\text{onset}}(v) + w_{\text{latency}} \cdot C_{\text{latency}}(v) + w_{\text{error}} \cdot C_{\text{error}}(v) + w_{\text{impact}} \cdot C_{\text{impact}}(v)$$

Where:
1. **Topological Depth ($C_{\text{depth}}$):** Services deepest in the dependency chain (leaf nodes, databases) receive higher root-cause priority. Callers typically suffer downstream consequence latency, not origin latency.
2. **First-to-Fail Onset ($C_{\text{onset}}$):** The service whose sliding-window metrics breached threshold earliest in time receives maximum onset points.
3. **Latency Ratio ($C_{\text{latency}}$):** Ratio of observed latency to baseline: $\min(100, \frac{\bar{L}}{L_{\text{base}}} \cdot 20)$.
4. **Error Rate Delta ($C_{\text{error}}$):** Absolute percentage increase in HTTP 5xx responses.
5. **Blast Radius Impact ($C_{\text{impact}}$):** Ratio of total fleet services degraded by this node's failure, calculated via BFS impact traversal.

### 6.2 Complexity Analysis
- **Time Complexity:** $O(V \cdot (E + W) + V \log V)$
  - BFS traversal per anomalous node: $O(V \cdot (V + E))$ worst-case ($O(V + E)$ in sparse trees).
  - Sliding window evaluation: $O(V \cdot W)$.
  - Max-heap insertion and extraction: $O(V \log V)$.
- **Space Complexity:** $O(V + E + W)$.

---

## 7. Fast Indexed Lookups & Set Operations

- **Lookup Structure:** Hash Maps (`Map<string, ServiceNodeData>`)
- **Membership Structure:** Hash Sets (`Set<string>`)
- **Operations:**
  - $O(1)$ amortized lookups to retrieve node metadata during traversals.
  - $O(1)$ amortized set membership tests to prevent infinite loops in cyclic topologies.
  - $O(1)$ index lookups mapping PromQL service label results to in-memory graph nodes.
