export type TelemetryMode = "SIMULATION" | "LIVE" | "DEGRADED" | "REAL";

export type TelemetryProvenanceState = "LIVE" | "MOCK_EMULATION" | "LOCAL" | "DISABLED" | "ERROR";

export interface BackendHealthStatus {
  prometheusAvailable: boolean;
  jaegerAvailable: boolean;
  prometheusUrl: string;
  jaegerUrl: string;
  isMockBackend: boolean;
  isCloudBackend: boolean;
  cloudConfigured: boolean;
  backendType: "GRAFANA_CLOUD" | "GENUINE_STACK" | "MOCK_EMULATION" | "UNAVAILABLE" | "SIMULATION";
  provenance?: TelemetryProvenanceState;
  details?: string;
  lastChecked: string;
  lastIngestedAt?: string;
  lastVerifiedAt?: string;
  metricsIngested?: boolean;
  tracesIngested?: boolean;
}

export interface ObservedServiceMetric {
  serviceId: string;
  serviceName: string;
  source: "PROMETHEUS" | "JAEGER" | "SIMULATION";
  provenance?: TelemetryProvenanceState;
  status: "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN";
  latencyMs: number;
  hasValidLatency?: boolean;
  latencyP95Ms?: number;
  hasValidP95?: boolean;
  errorRate: number; // 0 - 100 percentage
  hasValidErrorRate?: boolean;
  requestRate: number; // req/sec
  hasValidRequestRate?: boolean;
  lastObserved: string;
  traceCount: number;
  isStale: boolean;
  isKnownInTopology: boolean;
}

export interface SpanReference {
  refType: "CHILD_OF" | "FOLLOWS_FROM";
  traceId: string;
  spanId: string;
}

export interface TraceSpan {
  spanId: string;
  parentSpanId?: string;
  traceId: string;
  operationName: string;
  serviceName: string;
  startTimeUs: number; // microseconds
  durationMs: number;
  statusCode: "OK" | "ERROR" | "UNSET";
  errorMessage?: string;
  attributes: Record<string, unknown>;
  depth: number;
  children: TraceSpan[];
}

export interface DistributedTrace {
  traceId: string;
  rootServiceName: string;
  operationName: string;
  startTime: string;
  durationMs: number;
  totalSpans: number;
  hasErrors: boolean;
  servicesInvolved: string[];
  rootSpan: TraceSpan | null;
  allSpans: TraceSpan[];
}

export interface RealTelemetryEvidence {
  serviceId: string;
  evidenceType: "LATENCY_SPIKE" | "ERROR_RATE_SPIKE" | "DOWNSTREAM_TIMEOUT" | "DATABASE_CONTENTION";
  observedValue: number;
  threshold: number;
  unit: string;
  timestamp: string;
  explanation: string;
  relatedTraceId?: string;
}
