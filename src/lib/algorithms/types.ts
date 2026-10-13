export interface ServiceNodeData {
  id: string;
  name: string;
  serviceType: string;
  tier: number;
  status: "HEALTHY" | "DEGRADED" | "DOWN";
  baselineLatency: number;
  currentLatency: number;
  baselineErrorRate: number;
  currentErrorRate: number;
  requestRate: number;
}

export interface EdgeMetadata {
  dependencyType: "SYNC_HTTP" | "ASYNC_QUEUE" | "DATABASE_CONN";
  timeoutThreshold: number;
  criticality: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
}

export interface TraversalStep {
  serviceId: string;
  depth: number;
  path: string[];
  reason: string;
}

export interface CycleDetectionResult {
  hasCycle: boolean;
  cycles: string[][];
}

export interface GraphValidationResult {
  isValid: boolean;
  errors: string[];
  nodeCount: number;
  edgeCount: number;
}

export interface TelemetryPoint {
  serviceId: string;
  simulationStep: number;
  timestamp: Date | string;
  latency: number;
  errorRate: number;
  requestCount: number;
  healthStatus: string;
}

export interface SlidingWindowStats {
  serviceId: string;
  sampleCount: number;
  averageLatency: number;
  baselineLatency: number;
  latencyRatio: number; // current / baseline
  averageErrorRate: number;
  baselineErrorRate: number;
  errorRateDelta: number; // current - baseline
  firstAnomalousStep: number | null;
  hasLatencyAnomaly: boolean;
  hasErrorAnomaly: boolean;
}

export interface RootCauseEvidenceDetail {
  type: "TELEMETRY_SPIKE" | "TIMING_PRECEDENCE" | "GRAPH_TOPOLOGY" | "CASCADING_IMPACT" | "STATUS_SIGNAL";
  description: string;
  weight: number;
  scoreContribution: number;
}

export interface ContradictoryEvidenceDetail {
  description: string;
  penalty: number;
}

export interface RootCauseCandidateResult {
  serviceId: string;
  serviceName: string;
  rank: number;
  score: number; // 0 - 100 heuristic ranking score
  confidence: "HIGH" | "MEDIUM" | "LOW" | "INCONCLUSIVE";
  explanation: string;
  supportingEvidence: RootCauseEvidenceDetail[];
  contradictoryEvidence: ContradictoryEvidenceDetail[];
  recommendedAction: string;
  affectedDependentsCount: number;
}

export interface IncidentAnalysisSummary {
  incidentId: string;
  analyzedAt: string;
  totalCandidatesEvaluated: number;
  topRootCause: RootCauseCandidateResult | null;
  allCandidates: RootCauseCandidateResult[];
  affectedServicesGraph: TraversalStep[];
  isConclusive: boolean;
  algorithmExecutionTimeMs: number;
}
