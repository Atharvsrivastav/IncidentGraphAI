import { TelemetryProvenance } from "../types";

export interface AIInvestigationContext {
  incidentId: string;
  incidentTitle: string;
  incidentDescription: string;
  severity: string;
  status: string;
  startedAt: string;
  provenance: TelemetryProvenance;
  topology: Array<{
    id: string;
    name: string;
    serviceType: string;
    tier: number;
    status: string;
    baselineLatency: number;
    currentLatency: number;
    baselineErrorRate: number;
    currentErrorRate: number;
    dependencies: string[];
  }>;
  evidences: Array<{
    id: string;
    serviceId: string;
    evidenceType: string;
    observedValue: number;
    expectedValue: number;
    threshold: number;
    unit: string;
    timestamp: string;
    explanation: string;
  }>;
  deterministicCandidates: Array<{
    serviceId: string;
    rank: number;
    score: number;
    confidence: string;
    explanation: string;
    recommendedAction: string;
  }>;
  recentTraces?: Array<{
    traceId: string;
    rootService: string;
    durationMs: number;
    hasErrors: boolean;
    servicesInvolved: string[];
    bottleneckSpan?: {
      service: string;
      operation: string;
      durationMs: number;
      isError: boolean;
    };
  }>;
}

export interface AIProviderResult {
  rawJson: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  executionTimeMs: number;
}

export type AIProviderErrorCode =
  | "UNCONFIGURED"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "AUTHENTICATION_FAILED"
  | "PROVIDER_UNAVAILABLE"
  | "MALFORMED_OUTPUT"
  | "NETWORK_ERROR";

export class AIProviderError extends Error {
  public readonly code: AIProviderErrorCode;
  public readonly status: number;
  public readonly retryAfterSeconds?: number;

  constructor(message: string, code: AIProviderErrorCode, status: number = 500, retryAfterSeconds?: number) {
    super(message);
    this.name = "AIProviderError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface AIProvider {
  readonly providerName: string;
  readonly modelName: string;
  isConfigured(): boolean;
  generateInvestigation(context: AIInvestigationContext): Promise<AIProviderResult>;
}
