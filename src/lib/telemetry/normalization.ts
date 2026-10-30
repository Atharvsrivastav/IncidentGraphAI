import { z } from "zod";

// Provider error codes for safe, un-leaked diagnostics
export const TelemetryErrorCodeSchema = z.enum([
  "TIMEOUT",
  "AUTH_FAILURE",
  "RATE_LIMITED",
  "BAD_REQUEST",
  "UNAVAILABLE",
  "MALFORMED_RESPONSE",
  "UNKNOWN_ERROR",
]);
export type TelemetryErrorCode = z.infer<typeof TelemetryErrorCodeSchema>;

export interface ProviderDiagnostic {
  provider: "PROMETHEUS" | "TEMPO" | "OTLP" | "SIMULATED";
  endpoint: string;
  status: "OK" | "ERROR";
  errorCode?: TelemetryErrorCode;
  message: string;
  latencyMs: number;
  timestamp: string;
}

// Normalized Metric Schema & Type
export const MetricTypeSchema = z.enum([
  "REQUEST_RATE",
  "ERROR_RATE",
  "LATENCY_P95",
  "LATENCY_AVG",
  "CPU_UTILIZATION",
  "MEMORY_UTILIZATION",
  "DB_CONNECTION_PRESSURE",
  "CUSTOM",
]);
export type MetricType = z.infer<typeof MetricTypeSchema>;

export const NormalizedMetricRecordSchema = z.object({
  id: z.string(),
  provider: z.enum(["PROMETHEUS", "GRAFANA_CLOUD", "MOCK_EMULATION", "SIMULATION"]),
  serviceName: z.string().min(1),
  metricType: MetricTypeSchema,
  metricName: z.string().min(1),
  timestamp: z.string().datetime(),
  value: z.number(),
  unit: z.string(),
  labels: z.record(z.string(), z.string()).default({}),
  hasAnomaly: z.boolean().default(false),
});
export type NormalizedMetricRecord = z.infer<typeof NormalizedMetricRecordSchema>;

// Normalized Trace Span Schema & Type
export const NormalizedTraceSpanSchema = z.object({
  traceId: z.string().min(1),
  spanId: z.string().min(1),
  parentSpanId: z.string().optional(),
  serviceName: z.string().min(1),
  operationName: z.string().min(1),
  startTimeIso: z.string().datetime(),
  durationMs: z.number().nonnegative(),
  statusCode: z.enum(["OK", "ERROR", "UNSET"]),
  errorMessage: z.string().optional(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  childSpanIds: z.array(z.string()).default([]),
  depth: z.number().int().nonnegative().default(0),
});
export type NormalizedTraceSpan = z.infer<typeof NormalizedTraceSpanSchema>;

// Normalized Batch Container
export const NormalizedTelemetryBatchSchema = z.object({
  batchId: z.string().min(1),
  collectedAt: z.string().datetime(),
  mode: z.enum(["SIMULATION", "LIVE", "DEGRADED"]),
  metrics: z.array(NormalizedMetricRecordSchema),
  spans: z.array(NormalizedTraceSpanSchema),
  diagnostics: z.array(
    z.object({
      provider: z.enum(["PROMETHEUS", "TEMPO", "OTLP", "SIMULATED"]),
      endpoint: z.string(),
      status: z.enum(["OK", "ERROR"]),
      errorCode: TelemetryErrorCodeSchema.optional(),
      message: z.string(),
      latencyMs: z.number(),
      timestamp: z.string(),
    })
  ),
});
export type NormalizedTelemetryBatch = z.infer<typeof NormalizedTelemetryBatchSchema>;

// Factory validation helpers
export function validateMetricRecord(data: unknown): NormalizedMetricRecord {
  return NormalizedMetricRecordSchema.parse(data);
}

export function validateTraceSpan(data: unknown): NormalizedTraceSpan {
  return NormalizedTraceSpanSchema.parse(data);
}

export function validateTelemetryBatch(data: unknown): NormalizedTelemetryBatch {
  return NormalizedTelemetryBatchSchema.parse(data);
}
