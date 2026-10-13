"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw } from "lucide-react";

type AlgorithmTab = "BFS" | "DFS_CYCLES" | "PRIORITY_QUEUE" | "SLIDING_WINDOW" | "ROOT_CAUSE_ENGINE";

interface BfsStep {
  depth: number;
  serviceId: string;
  reason: string;
  path: string[];
}

interface PqNodeItem {
  priority: number;
  item: {
    name: string;
  };
}

interface WindowStatsResult {
  serviceId: string;
  averageLatency: number;
  baselineLatency: number;
  latencyRatio: number;
  averageErrorRate: number;
  errorRateDelta: number;
}

interface CandidateItemResult {
  rank: number;
  serviceId: string;
  serviceName: string;
  confidence: string;
  score: number;
}

interface DsaRunData {
  executionTimeMs?: number;
  traversal?: BfsStep[];
  hasCycle?: boolean;
  cycles?: string[][];
  extractedOrder?: PqNodeItem[];
  stats?: WindowStatsResult;
  analysis?: {
    totalCandidatesEvaluated: number;
    allCandidates: CandidateItemResult[];
  };
}

export default function DSALabPage() {
  const [activeTab, setActiveTab] = useState<AlgorithmTab>("BFS");
  const [selectedServiceId, setSelectedServiceId] = useState<string>("postgres-db");
  const [windowSize, setWindowSize] = useState<number>(5);
  const [injectTestCycle, setInjectTestCycle] = useState<boolean>(false);
  const [runResult, setRunResult] = useState<DsaRunData | null>(null);
  const [running, setRunning] = useState<boolean>(false);

  const runAlgorithm = useCallback(async (tab = activeTab) => {
    setRunning(true);
    try {
      const res = await fetch("/api/dsa/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          algorithm: tab,
          selectedServiceId,
          windowSize,
          injectTestCycle,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setRunResult(data);
      }
    } finally {
      setRunning(false);
    }
  }, [activeTab, selectedServiceId, windowSize, injectTestCycle]);

  useEffect(() => {
    let ignore = false;
    const execute = async () => {
      try {
        const res = await fetch("/api/dsa/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            algorithm: activeTab,
            selectedServiceId,
            windowSize,
            injectTestCycle,
          }),
        });
        if (res.ok && !ignore) {
          const data = await res.json();
          setRunResult(data);
        }
      } finally {
        if (!ignore) setRunning(false);
      }
    };
    void execute();
    return () => {
      ignore = true;
    };
  }, [activeTab, selectedServiceId, windowSize, injectTestCycle]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 space-y-8">
      {/* Header */}
      <div className="rounded-2xl border border-slate-800 bg-gradient-to-r from-slate-900/90 via-slate-900/60 to-slate-950 p-6 shadow-xl backdrop-blur-md">
        <div className="flex items-center gap-2">
          <span className="rounded bg-indigo-500/20 px-2.5 py-0.5 text-xs font-semibold text-indigo-400 border border-indigo-500/30">
            DSA Engine Diagnostics
          </span>
          <span className="text-xs text-slate-400 font-mono">Live Educational Sandbox</span>
        </div>
        <h1 className="mt-1.5 text-2xl font-black text-white tracking-tight sm:text-3xl">
          Data Structures & Algorithms Lab
        </h1>
        <p className="mt-1 text-xs text-slate-400 max-w-3xl leading-relaxed">
          IncidentGraph AI utilizes rigorous graph theory and priority queues to detect originating
          faults without reading injected ground truth. Test the actual algorithmic layer below.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-slate-800 pb-2">
        {[
          { id: "BFS", label: "1. BFS (Impact Propagation)" },
          { id: "DFS_CYCLES", label: "2. DFS (Cycle Detection)" },
          { id: "PRIORITY_QUEUE", label: "3. Priority Queue (Binary Heap)" },
          { id: "SLIDING_WINDOW", label: "4. Sliding Window Telemetry" },
          { id: "ROOT_CAUSE_ENGINE", label: "5. Root-Cause Ranking Engine" },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as AlgorithmTab)}
            className={`rounded-xl px-4 py-2 text-xs font-semibold transition-all ${
              activeTab === tab.id
                ? "bg-blue-600 text-white font-bold shadow-lg shadow-blue-600/30"
                : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Algorithm Specs & Execution Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Specification Column */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-md space-y-5">
          <h3 className="text-sm font-bold text-white tracking-tight uppercase font-mono">
            Algorithm Metadata
          </h3>

          {/* Tab 1 Spec: BFS */}
          {activeTab === "BFS" && (
            <div className="space-y-4 text-xs text-slate-300">
              <div>
                <span className="text-[10px] font-mono uppercase text-slate-400">Purpose</span>
                <p className="mt-1 font-medium text-slate-200">
                  Traverses reverse-dependency edges to compute the exact downstream blast radius of a failing service.
                </p>
              </div>
              <div>
                <span className="text-[10px] font-mono uppercase text-slate-400">Why It Solves the Problem</span>
                <p className="mt-1 text-slate-400 leading-relaxed">
                  Edges represent calls: A → B (A depends on B). When B fails, impact travels against the edge direction to its callers (reverse adjacency list). BFS discovers all callers in topological distance order.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-800 font-mono text-[11px]">
                <div>
                  <span className="text-slate-400 block">Time Complexity</span>
                  <strong className="text-blue-400">O(V + E)</strong>
                </div>
                <div>
                  <span className="text-slate-400 block">Space Complexity</span>
                  <strong className="text-blue-400">O(V)</strong>
                </div>
              </div>
            </div>
          )}

          {/* Tab 2 Spec: DFS */}
          {activeTab === "DFS_CYCLES" && (
            <div className="space-y-4 text-xs text-slate-300">
              <div>
                <span className="text-[10px] font-mono uppercase text-slate-400">Purpose</span>
                <p className="mt-1 font-medium text-slate-200">
                  Explores recursive dependency chains and detects dangerous circular dependency cycles using 3-color state coloring.
                </p>
              </div>
              <div>
                <span className="text-[10px] font-mono uppercase text-slate-400">3-Color Scheme</span>
                <p className="mt-1 text-slate-400 leading-relaxed font-mono text-[11px]">
                  • White (0): Unvisited node<br />
                  • Gray (1): In current recursion call stack<br />
                  • Black (2): Completed and backtracked<br />
                  If an edge points to a Gray node, a directed cycle exists.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-800 font-mono text-[11px]">
                <div>
                  <span className="text-slate-400 block">Time Complexity</span>
                  <strong className="text-blue-400">O(V + E)</strong>
                </div>
                <div>
                  <span className="text-slate-400 block">Space Complexity</span>
                  <strong className="text-blue-400">O(V)</strong>
                </div>
              </div>
            </div>
          )}

          {/* Tab 3 Spec: Priority Queue */}
          {activeTab === "PRIORITY_QUEUE" && (
            <div className="space-y-4 text-xs text-slate-300">
              <div>
                <span className="text-[10px] font-mono uppercase text-slate-400">Purpose</span>
                <p className="mt-1 font-medium text-slate-200">
                  Maintains a dynamic Max-Heap to extract the top-K highest-probability root cause candidates.
                </p>
              </div>
              <div>
                <span className="text-[10px] font-mono uppercase text-slate-400">Implementation</span>
                <p className="mt-1 text-slate-400 leading-relaxed font-mono text-[11px]">
                  Complete Binary Tree in array storage. Node at index i has parent at ⌊(i-1)/2⌋ and children at 2i+1 and 2i+2.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-800 font-mono text-[11px]">
                <div>
                  <span className="text-slate-400 block">Insert / Extract</span>
                  <strong className="text-blue-400">O(log N)</strong>
                </div>
                <div>
                  <span className="text-slate-400 block">Top-K Selection</span>
                  <strong className="text-blue-400">O(K log N)</strong>
                </div>
              </div>
            </div>
          )}

          {/* Tab 4 Spec: Sliding Window */}
          {activeTab === "SLIDING_WINDOW" && (
            <div className="space-y-4 text-xs text-slate-300">
              <div>
                <span className="text-[10px] font-mono uppercase text-slate-400">Purpose</span>
                <p className="mt-1 font-medium text-slate-200">
                  Computes bounded moving averages of response times and error rates while identifying earliest anomaly onset step.
                </p>
              </div>
              <div>
                <span className="text-[10px] font-mono uppercase text-slate-400">Mathematical Safety</span>
                <p className="mt-1 text-slate-400 leading-relaxed font-mono text-[11px]">
                  Safe denominators: guards against division by zero if sample count is 0 or baseline is 0.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-800 font-mono text-[11px]">
                <div>
                  <span className="text-slate-400 block">Time Complexity</span>
                  <strong className="text-blue-400">O(W)</strong>
                </div>
                <div>
                  <span className="text-slate-400 block">Space Complexity</span>
                  <strong className="text-blue-400">O(W)</strong>
                </div>
              </div>
            </div>
          )}

          {/* Tab 5 Spec: Root Cause Engine */}
          {activeTab === "ROOT_CAUSE_ENGINE" && (
            <div className="space-y-4 text-xs text-slate-300">
              <div>
                <span className="text-[10px] font-mono uppercase text-slate-400">Purpose</span>
                <p className="mt-1 font-medium text-slate-200">
                  Deterministic heuristic ranking aggregating status signals, sliding window metrics, temporal precedence, and reachability.
                </p>
              </div>
              <div>
                <span className="text-[10px] font-mono uppercase text-slate-400">Heuristic Weights</span>
                <div className="mt-1 space-y-1 font-mono text-[11px] text-slate-400">
                  <div>• Explicit Status (DOWN/DEGRADED): max 25 pts</div>
                  <div>• Latency/Error Spike: max 25 pts</div>
                  <div>• Temporal Precedence: max 25 pts</div>
                  <div>• Graph Reachability Coverage: max 25 pts</div>
                  <div>• Contradictory Evidence: up to -40 penalty</div>
                </div>
              </div>
              <div className="pt-2 border-t border-slate-800 font-mono text-[11px]">
                <span className="text-slate-400 block">Time Complexity</span>
                <strong className="text-blue-400">O(V · (E + W) + V log V)</strong>
              </div>
            </div>
          )}
        </div>

        {/* Right Interactive Execution Column */}
        <div className="lg:col-span-2 rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-md space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800">
            <div>
              <h3 className="text-sm font-bold text-white tracking-tight uppercase font-mono">
                Live Algorithm Execution
              </h3>
              <span className="text-xs text-slate-400 font-mono">
                Real code running against in-memory graph
              </span>
            </div>

            <div className="flex items-center gap-2">
              {runResult?.executionTimeMs !== undefined && (
                <span className="rounded bg-slate-800 px-2 py-1 text-[11px] font-mono text-emerald-400 border border-emerald-900/30">
                  Latency: {runResult.executionTimeMs}ms
                </span>
              )}
              <button
                onClick={() => void runAlgorithm()}
                disabled={running}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} />
                <span>Execute</span>
              </button>
            </div>
          </div>

          {/* Interactive Controls per Tab */}
          {activeTab === "BFS" && (
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <label className="text-slate-400 font-mono">Originating Failing Service:</label>
              <select
                value={selectedServiceId}
                onChange={(e) => setSelectedServiceId(e.target.value)}
                className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5 text-slate-200 font-mono text-xs focus:outline-none"
              >
                <option value="postgres-db">PostgreSQL Database Cluster</option>
                <option value="order-service">Order Service</option>
                <option value="payment-service">Payment Service</option>
                <option value="inventory-service">Inventory Service</option>
                <option value="auth-service">Authentication Service</option>
                <option value="api-gateway">API Gateway</option>
              </select>
            </div>
          )}

          {activeTab === "DFS_CYCLES" && (
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={injectTestCycle}
                  onChange={(e) => setInjectTestCycle(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-800"
                />
                <span>Simulate Cycle Injection (postgres-db → api-gateway)</span>
              </label>
            </div>
          )}

          {activeTab === "SLIDING_WINDOW" && (
            <div className="flex items-center gap-4 text-xs font-mono">
              <span className="text-slate-400">Window Size W: {windowSize} samples</span>
              <input
                type="range"
                min="1"
                max="10"
                value={windowSize}
                onChange={(e) => setWindowSize(Number(e.target.value))}
                className="accent-blue-500"
              />
            </div>
          )}

          {/* Results Output */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 font-mono text-xs text-slate-200 overflow-x-auto min-h-[260px]">
            {running ? (
              <div className="flex h-48 items-center justify-center text-slate-500">
                <RefreshCw className="h-5 w-5 animate-spin mr-2" />
                <span>Executing algorithm...</span>
              </div>
            ) : runResult ? (
              <div className="space-y-4">
                {activeTab === "BFS" && (
                  <div>
                    <div className="text-slate-400 text-[11px] mb-2">
                      BFS Impact Traversal Steps (Reverse Dependencies):
                    </div>
                    {(!runResult.traversal || runResult.traversal.length === 0) ? (
                      <div className="text-slate-500 italic">No downstream dependents affected.</div>
                    ) : (
                      runResult.traversal.map((step, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between border-b border-slate-900 py-2"
                        >
                          <div>
                            <span className="text-purple-400 font-bold">Depth {step.depth}: </span>
                            <span className="text-white font-semibold">{step.serviceId}</span>
                            <span className="text-[11px] text-slate-400 ml-2">({step.reason})</span>
                          </div>
                          <span className="text-[10px] text-slate-400 font-mono">
                            Path: {step.path.join(" → ")}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {activeTab === "DFS_CYCLES" && (
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-slate-400 text-[11px]">Cycle Detection Result:</span>
                      <span
                        className={`rounded px-2 py-0.5 text-[11px] font-bold ${
                          runResult.hasCycle
                            ? "bg-rose-500/20 text-rose-400 border border-rose-500/30"
                            : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                        }`}
                      >
                        {runResult.hasCycle ? "DIRECTED CYCLE DETECTED" : "GRAPH IS ACYCLIC (DAG)"}
                      </span>
                    </div>

                    {runResult.hasCycle ? (
                      <div className="space-y-2">
                        {runResult.cycles?.map((cycle, idx) => (
                          <div key={idx} className="rounded-lg bg-rose-950/20 border border-rose-900/40 p-2 text-rose-300">
                            Cycle #{idx + 1}: {cycle.join(" → ")}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-slate-400 text-xs">
                        No circular dependency back-edges found in current topology. Graph integrity verified.
                      </p>
                    )}
                  </div>
                )}

                {activeTab === "PRIORITY_QUEUE" && (
                  <div>
                    <div className="text-slate-400 text-[11px] mb-2">
                      Heap Extraction Order (Max-Heap by Priority Score):
                    </div>
                    <div className="space-y-2">
                      {runResult.extractedOrder?.map((node, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between rounded-lg bg-slate-900/60 p-2 text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-bold text-slate-400">
                              #{idx + 1}
                            </span>
                            <span className="text-slate-200">{node.item.name}</span>
                          </div>
                          <span className="font-bold text-purple-400">
                            Priority Score: {node.priority}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {activeTab === "SLIDING_WINDOW" && (
                  <div className="space-y-2">
                    <div className="text-slate-400 text-[11px] mb-2">
                      Sliding Window Summary for {runResult.stats?.serviceId}:
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div className="rounded-lg bg-slate-900/80 p-3">
                        <span className="text-slate-400 text-[10px]">Average Latency</span>
                        <div className="text-base font-bold text-white">
                          {runResult.stats?.averageLatency}ms
                        </div>
                        <span className="text-[10px] text-slate-400">
                          Baseline: {runResult.stats?.baselineLatency}ms ({runResult.stats?.latencyRatio}x)
                        </span>
                      </div>
                      <div className="rounded-lg bg-slate-900/80 p-3">
                        <span className="text-slate-400 text-[10px]">Average Error Rate</span>
                        <div className="text-base font-bold text-white">
                          {runResult.stats?.averageErrorRate}%
                        </div>
                        <span className="text-[10px] text-slate-400">
                          Delta: +{runResult.stats?.errorRateDelta}%
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === "ROOT_CAUSE_ENGINE" && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-[11px] text-slate-400">
                      <span>Evaluated Candidates: {runResult.analysis?.totalCandidatesEvaluated}</span>
                      <span>Execution Time: {runResult.executionTimeMs}ms</span>
                    </div>

                    {runResult.analysis?.allCandidates?.map((cand) => (
                      <div
                        key={cand.serviceId}
                        className="flex items-center justify-between rounded-lg bg-slate-900/70 p-2.5 text-xs"
                      >
                        <div>
                          <span className="font-bold text-white">#{cand.rank} {cand.serviceName}</span>
                          <span className="text-slate-400 text-[10px] ml-2 font-mono">
                            ({cand.confidence})
                          </span>
                        </div>
                        <span className="font-bold font-mono text-purple-400">
                          Score: {cand.score}/100
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-slate-500 italic">Click Execute to run this algorithm.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
