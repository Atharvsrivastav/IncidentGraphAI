import { DistributedTrace, TraceSpan } from "./types";
import {
  NormalizedTraceSpan,
  ProviderDiagnostic,
  TelemetryErrorCode,
} from "./normalization";

interface RawJaegerTag {
  key: string;
  type: string;
  value: unknown;
}

interface RawJaegerSpan {
  traceID: string;
  spanID: string;
  operationName: string;
  references?: Array<{ refType: string; traceID: string; spanID: string }>;
  startTime: number;
  duration: number;
  tags: RawJaegerTag[];
  process?: { serviceName: string };
  processID?: string;
}

interface RawJaegerTrace {
  traceID: string;
  spans: RawJaegerSpan[];
  processes?: Record<string, { serviceName: string }>;
}

interface TempoSearchTrace {
  traceID: string;
  rootServiceName?: string;
  rootTraceName?: string;
  startTimeUnixNano?: string;
  durationMs?: number;
  spanSet?: {
    spans?: Array<{
      spanID: string;
      name?: string;
      startTimeUnixNano?: string;
      durationNanos?: number;
      attributes?: Array<{ key: string; value: { stringValue?: string; intValue?: number; boolValue?: boolean } }>;
    }>;
  };
}

export interface TraceQueryDetailedResult {
  success: boolean;
  traces: DistributedTrace[];
  normalizedSpans: NormalizedTraceSpan[];
  diagnostic: ProviderDiagnostic;
}

export class JaegerClient {
  private baseUrl: string;
  private timeoutMs: number;
  private isCloud: boolean;
  private authHeader: string | null = null;

  constructor(customUrl?: string, customTimeoutMs?: number) {
    const cloudUrl = process.env.GRAFANA_CLOUD_TEMPO_URL;
    const cloudUser = process.env.GRAFANA_CLOUD_TEMPO_USER || process.env.GRAFANA_CLOUD_INSTANCE_ID;
    const cloudToken = process.env.GRAFANA_CLOUD_TEMPO_TOKEN;

    if (customUrl) {
      this.baseUrl = customUrl.replace(/\/$/, "");
      this.isCloud = false;
    } else if (cloudUrl && cloudUrl.trim().length > 0) {
      this.baseUrl = cloudUrl.trim().replace(/\/$/, "");
      this.isCloud = true;
      if (cloudUser && cloudToken) {
        this.authHeader = `Basic ${Buffer.from(`${cloudUser.trim()}:${cloudToken.trim()}`).toString("base64")}`;
      }
    } else {
      this.baseUrl = (process.env.JAEGER_URL || "http://localhost:16686").replace(/\/$/, "");
      this.isCloud = false;
    }

    this.timeoutMs = customTimeoutMs || Number(process.env.TELEMETRY_QUERY_TIMEOUT_MS) || 4000;
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public isCloudBackend(): boolean {
    return this.isCloud;
  }

  private getRequestHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }
    return headers;
  }

  public async checkHealth(): Promise<{ available: boolean; isMock?: boolean; isCloud?: boolean; error?: string; errorCode?: TelemetryErrorCode }> {
    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const probePath = this.isCloud ? "/api/search?limit=1" : "/api/traces?limit=1";
      const url = `${this.baseUrl}${probePath}`;

      const res = await fetch(url, {
        signal: controller.signal,
        headers: this.getRequestHeaders(),
      });

      if (res.status === 401 || res.status === 403) {
        return {
          available: false,
          isCloud: this.isCloud,
          errorCode: "AUTH_FAILURE",
          error: `Authentication failed (${res.status}). Verify credentials and read permissions.`,
        };
      }
      if (res.status === 429) {
        return {
          available: false,
          isCloud: this.isCloud,
          errorCode: "RATE_LIMITED",
          error: "Tempo endpoint rate limited (429 Too Many Requests).",
        };
      }
      if (!res.ok) {
        return {
          available: false,
          isCloud: this.isCloud,
          errorCode: res.status >= 500 ? "UNAVAILABLE" : "BAD_REQUEST",
          error: `Trace probe failed with status ${res.status}.`,
        };
      }

      await res.json();
      const isMock = res.headers.get("x-observability-provider") === "mock-observability-server";
      return { available: true, isMock, isCloud: this.isCloud };
    } catch (err: unknown) {
      const elapsed = Date.now() - start;
      const isTimeout = elapsed >= this.timeoutMs || (err instanceof Error && err.name === "AbortError");
      return {
        available: false,
        isMock: false,
        isCloud: this.isCloud,
        errorCode: isTimeout ? "TIMEOUT" : "UNAVAILABLE",
        error: isTimeout ? `Trace probe timed out after ${this.timeoutMs}ms` : "Trace endpoint unreachable",
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  public async getRecentTracesDetailed(service?: string, limit: number = 20): Promise<TraceQueryDetailedResult> {
    const start = Date.now();
    const nowIso = new Date().toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = this.isCloud
        ? `${this.baseUrl}/api/search?limit=${limit}${service ? `&tags=service.name=${encodeURIComponent(service)}` : ""}`
        : `${this.baseUrl}/api/traces?limit=${limit}${service ? `&service=${encodeURIComponent(service)}` : ""}`;

      const res = await fetch(url, {
        signal: controller.signal,
        headers: this.getRequestHeaders(),
      });

      const latencyMs = Date.now() - start;
      if (res.status === 401 || res.status === 403) {
        return this.createFailureResult(latencyMs, nowIso, "AUTH_FAILURE", `Authentication failed (${res.status})`);
      }
      if (res.status === 429) {
        return this.createFailureResult(latencyMs, nowIso, "RATE_LIMITED", "Trace query rate limited (429)");
      }
      if (!res.ok) {
        const code: TelemetryErrorCode = res.status >= 500 ? "UNAVAILABLE" : "BAD_REQUEST";
        return this.createFailureResult(latencyMs, nowIso, code, `Trace query failed with HTTP ${res.status}`);
      }

      let json: { data?: RawJaegerTrace[]; traces?: TempoSearchTrace[] };
      try {
        json = await res.json();
      } catch (err: unknown) {
        if (
          controller.signal.aborted ||
          (err instanceof Error && err.name === "AbortError") ||
          Date.now() - start >= this.timeoutMs
        ) {
          throw err;
        }
        return this.createFailureResult(latencyMs, nowIso, "MALFORMED_RESPONSE", "Invalid JSON payload in trace response");
      }

      let traces: DistributedTrace[] = [];
      if (Array.isArray(json.data)) {
        traces = json.data.map((raw) => this.parseTrace(raw));
      } else if (Array.isArray(json.traces)) {
        traces = json.traces.map((t) => this.parseTempoSearchTrace(t));
      }

      const normalizedSpans: NormalizedTraceSpan[] = [];
      for (const t of traces) {
        for (const s of t.allSpans) {
          normalizedSpans.push(this.toNormalizedSpan(s));
        }
      }

      return {
        success: true,
        traces,
        normalizedSpans,
        diagnostic: {
          provider: "TEMPO",
          endpoint: this.baseUrl,
          status: "OK",
          message: `Retrieved ${traces.length} traces with ${normalizedSpans.length} spans in ${latencyMs}ms`,
          latencyMs,
          timestamp: nowIso,
        },
      };
    } catch (err: unknown) {
      const latencyMs = Date.now() - start;
      const isTimeout = latencyMs >= this.timeoutMs || controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
      return this.createFailureResult(
        latencyMs,
        nowIso,
        isTimeout ? "TIMEOUT" : "UNAVAILABLE",
        isTimeout ? `Trace query timed out after ${this.timeoutMs}ms` : "Trace request failed"
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private createFailureResult(
    latencyMs: number,
    timestamp: string,
    errorCode: TelemetryErrorCode,
    message: string
  ): TraceQueryDetailedResult {
    return {
      success: false,
      traces: [],
      normalizedSpans: [],
      diagnostic: {
        provider: "TEMPO",
        endpoint: this.baseUrl,
        status: "ERROR",
        errorCode,
        message,
        latencyMs,
        timestamp,
      },
    };
  }

  public async getRecentTraces(service?: string, limit: number = 20): Promise<DistributedTrace[]> {
    const detailed = await this.getRecentTracesDetailed(service, limit);
    return detailed.traces;
  }

  public async getTraceById(traceId: string, options?: { allowFallback?: boolean }): Promise<DistributedTrace | null> {
    const allowFallback = options?.allowFallback !== false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `${this.baseUrl}/api/traces/${encodeURIComponent(traceId)}`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: this.getRequestHeaders(),
      });

      if (!res.ok) return null;
      const json = await res.json();

      if (Array.isArray(json.data) && json.data.length > 0) {
        const rawTrace = json.data[0];
        if (!allowFallback) {
          if (!rawTrace.traceID || typeof rawTrace.traceID !== "string" || rawTrace.traceID.trim().length === 0) {
            return null;
          }
          if (!Array.isArray(rawTrace.spans) || rawTrace.spans.length === 0) {
            return null;
          }
          const seenSpans = new Set<string>();
          for (const s of rawTrace.spans) {
            if (!s.spanID || typeof s.spanID !== "string" || s.spanID.trim().length === 0) {
              return null;
            }
            if (seenSpans.has(s.spanID)) {
              return null;
            }
            seenSpans.add(s.spanID);
            if (!s.traceID || typeof s.traceID !== "string" || s.traceID.trim().length === 0) {
              return null;
            }
            if (s.traceID.toLowerCase() !== rawTrace.traceID.toLowerCase()) {
              return null;
            }
          }
        }
        const parsed = this.parseTrace(rawTrace);
        if (!allowFallback && (!parsed.allSpans || parsed.allSpans.length === 0)) {
          return null;
        }
        return parsed;
      }
      if (json.batches || json.resourceSpans || json.spans || json.traceID || json.traceId) {
        return this.parseTempoTraceDetail(json, traceId, { allowFallback });
      }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Strictly verifies that a returned trace was genuinely retrieved from the external backend
   * with actual spans matching the expected trace ID and verification attribute.
   * Fails on fallback traces, synthesized data, empty spans, ID mismatch, or missing verification ID.
   */
  public verifyLiveTrace(
    trace: DistributedTrace | null,
    expectedTraceId: string,
    expectedVerificationId: string
  ): { valid: boolean; reason?: string } {
    if (!trace) {
      return { valid: false, reason: "No trace returned from backend" };
    }
    if (trace.isFallback) {
      return { valid: false, reason: "Backend returned fallback trace; no actual span data exists in backend" };
    }
    if (!trace.traceId || trace.traceId.trim().length === 0) {
      return { valid: false, reason: "Missing root ID: Trace is missing root trace ID" };
    }
    const normTraceId = trace.traceId.toLowerCase().replace(/^0+/, "");
    const normExpectedId = expectedTraceId.toLowerCase().replace(/^0+/, "");
    if (normTraceId !== normExpectedId && trace.traceId.toLowerCase() !== expectedTraceId.toLowerCase()) {
      return {
        valid: false,
        reason: `Trace ID mismatch (Wrong root ID): expected ${expectedTraceId}, got ${trace.traceId}`,
      };
    }
    if (!trace.allSpans || trace.allSpans.length === 0) {
      return { valid: false, reason: "Trace contains no span data" };
    }
    const seenSpanIds = new Set<string>();
    for (const span of trace.allSpans) {
      if (!span.spanId || span.spanId.trim().length === 0) {
        return { valid: false, reason: "Missing span ID: Span is missing span ID" };
      }
      if (seenSpanIds.has(span.spanId)) {
        return { valid: false, reason: `Conflicting span IDs: duplicate span ID ${span.spanId}` };
      }
      seenSpanIds.add(span.spanId);

      if (!span.traceId || span.traceId.trim().length === 0) {
        return { valid: false, reason: `Missing span trace ID: Span ${span.spanId} is missing trace ID` };
      }
      const spanNorm = span.traceId.toLowerCase().replace(/^0+/, "");
      if (spanNorm !== normExpectedId && span.traceId.toLowerCase() !== expectedTraceId.toLowerCase()) {
        return {
          valid: false,
          reason: `Wrong individual span ID: Span ${span.spanId} trace ID mismatch: expected ${expectedTraceId}, got ${span.traceId}`,
        };
      }
    }
    const hasAttr = trace.allSpans.some(
      (s) =>
        s.attributes["verification.id"] === expectedVerificationId ||
        s.attributes["verification_id"] === expectedVerificationId
    );
    if (!hasAttr) {
      return {
        valid: false,
        reason: `Verification attribute '${expectedVerificationId}' not found in span hierarchy`,
      };
    }
    return { valid: true };
  }

  private toNormalizedSpan(s: TraceSpan): NormalizedTraceSpan {
    const attrs: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(s.attributes)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        attrs[k] = v;
      }
    }

    return {
      traceId: s.traceId,
      spanId: s.spanId,
      parentSpanId: s.parentSpanId,
      serviceName: s.serviceName,
      operationName: s.operationName,
      startTimeIso: new Date(s.startTimeUs / 1000).toISOString(),
      durationMs: s.durationMs,
      statusCode: s.statusCode,
      errorMessage: s.errorMessage,
      attributes: attrs,
      childSpanIds: s.children.map((c) => c.spanId),
      depth: s.depth,
    };
  }

  private parseTempoSearchTrace(t: TempoSearchTrace): DistributedTrace {
    const rootService = t.rootServiceName || "api-gateway";
    const duration = t.durationMs || 45;
    const nowIso = t.startTimeUnixNano
      ? new Date(Number(BigInt(t.startTimeUnixNano) / BigInt(1e6))).toISOString()
      : new Date().toISOString();

    const spansList: TraceSpan[] = [];
    if (t.spanSet?.spans && t.spanSet.spans.length > 0) {
      for (const s of t.spanSet.spans) {
        const attrs: Record<string, unknown> = { "service.name": rootService };
        for (const attr of s.attributes || []) {
          attrs[attr.key] = attr.value?.stringValue ?? attr.value?.intValue ?? attr.value?.boolValue;
        }
        spansList.push({
          spanId: s.spanID,
          traceId: t.traceID,
          operationName: s.name || t.rootTraceName || "HTTP Request",
          serviceName: rootService,
          startTimeUs: s.startTimeUnixNano ? Number(BigInt(s.startTimeUnixNano) / BigInt(1e3)) : Date.now() * 1000,
          durationMs: s.durationNanos ? Math.max(1, Math.round(Number(s.durationNanos) / 1e6)) : duration,
          statusCode: "OK",
          attributes: attrs,
          depth: 0,
          children: [],
        });
      }
    }

    const hasRealSpans = spansList.length > 0;
    const rootSpan: TraceSpan = hasRealSpans
      ? spansList[0]
      : {
          spanId: t.traceID.slice(0, 16),
          traceId: t.traceID,
          operationName: t.rootTraceName || "HTTP Request",
          serviceName: rootService,
          startTimeUs: Date.now() * 1000,
          durationMs: duration,
          statusCode: "OK",
          attributes: { "service.name": rootService },
          depth: 0,
          children: [],
        };

    const allSpans = hasRealSpans ? spansList : [rootSpan];

    return {
      traceId: t.traceID,
      rootServiceName: rootService,
      operationName: t.rootTraceName || "HTTP Request",
      startTime: nowIso,
      durationMs: duration,
      totalSpans: allSpans.length,
      hasErrors: false,
      servicesInvolved: [rootService],
      rootSpan,
      allSpans,
      isFallback: !hasRealSpans,
    };
  }

  public parseTempoTraceDetail(
    json: Record<string, unknown>,
    requestedTraceId: string,
    options?: { allowFallback?: boolean }
  ): DistributedTrace | null {
    const allowFallback = options?.allowFallback !== false;
    if (!json || typeof json !== "object") {
      return allowFallback ? this.createFallbackTrace(requestedTraceId) : null;
    }

    const jsonRecord = json as Record<string, unknown>;
    const jsonTraceID = typeof jsonRecord.traceID === "string" ? jsonRecord.traceID.trim() : "";
    const jsonTraceId = typeof jsonRecord.traceId === "string" ? jsonRecord.traceId.trim() : "";
    if (!allowFallback && jsonTraceID && jsonTraceId && jsonTraceID.toLowerCase() !== jsonTraceId.toLowerCase()) {
      return null;
    }
    const backendRootTraceId = jsonTraceID || jsonTraceId || undefined;

    if (!allowFallback && (!backendRootTraceId || backendRootTraceId.length === 0)) {
      return null;
    }

    const batches = ((jsonRecord.batches || jsonRecord.resourceSpans) as Array<{
      traceId?: string;
      traceID?: string;
      resource?: { attributes?: Array<{ key: string; value: { stringValue?: string } }> };
      scopeSpans?: Array<{
        spans?: Array<{
          traceId?: string;
          traceID?: string;
          spanId?: string;
          spanID?: string;
          parentSpanId?: string;
          parentSpanID?: string;
          name?: string;
          startTimeUnixNano?: string;
          endTimeUnixNano?: string;
          status?: { code?: number; message?: string };
          attributes?: Array<{ key: string; value: { stringValue?: string; intValue?: number; boolValue?: boolean } }>;
        }>;
      }>;
    }>) || [];

    if (!Array.isArray(batches) || batches.length === 0) {
      return allowFallback ? this.createFallbackTrace(backendRootTraceId || requestedTraceId) : null;
    }

    const allSpans: TraceSpan[] = [];
    const spanMap = new Map<string, TraceSpan>();
    const services = new Set<string>();
    let hasErrors = false;

    for (const batch of batches) {
      const serviceAttr = batch.resource?.attributes?.find((a) => a.key === "service.name");
      const serviceName = serviceAttr?.value?.stringValue || "unknown-service";
      services.add(serviceName);

      const batchTraceID = typeof batch.traceID === "string" ? batch.traceID.trim() : "";
      const batchTraceId = typeof batch.traceId === "string" ? batch.traceId.trim() : "";
      if (!allowFallback && batchTraceID && batchTraceId && batchTraceID.toLowerCase() !== batchTraceId.toLowerCase()) {
        return null;
      }
      const resolvedBatchTraceId = batchTraceID || batchTraceId || undefined;

      if (!allowFallback && backendRootTraceId && resolvedBatchTraceId && backendRootTraceId.toLowerCase() !== resolvedBatchTraceId.toLowerCase()) {
        return null;
      }

      for (const scope of batch.scopeSpans || []) {
        for (const rawSpan of scope.spans || []) {
          const spanTraceID = typeof rawSpan.traceID === "string" ? rawSpan.traceID.trim() : "";
          const spanTraceId = typeof rawSpan.traceId === "string" ? rawSpan.traceId.trim() : "";

          if (!allowFallback) {
            // Reject conflicting field spellings on the span
            if (spanTraceID && spanTraceId && spanTraceID.toLowerCase() !== spanTraceId.toLowerCase()) {
              return null;
            }
            // Require every span to contain its own non-empty backend-returned traceId or traceID
            if (!spanTraceID && !spanTraceId) {
              return null;
            }
          }

          const spanGenuineTraceId = spanTraceID || spanTraceId || undefined;
          const rawTraceId = spanGenuineTraceId || (allowFallback ? (resolvedBatchTraceId || backendRootTraceId) : undefined);
          if (!allowFallback && !rawTraceId) {
            return null;
          }
          if (!allowFallback && rawTraceId && backendRootTraceId && rawTraceId.toLowerCase() !== backendRootTraceId.toLowerCase()) {
            return null;
          }
          if (!allowFallback && rawTraceId && resolvedBatchTraceId && rawTraceId.toLowerCase() !== resolvedBatchTraceId.toLowerCase()) {
            return null;
          }

          const spanFinalTraceId = rawTraceId || (allowFallback ? requestedTraceId : "");

          const spanSpanID = typeof rawSpan.spanID === "string" ? rawSpan.spanID.trim() : "";
          const spanSpanId = typeof rawSpan.spanId === "string" ? rawSpan.spanId.trim() : "";

          if (!allowFallback) {
            if (spanSpanID && spanSpanId && spanSpanID.toLowerCase() !== spanSpanId.toLowerCase()) {
              return null;
            }
            if (!spanSpanID && !spanSpanId) {
              return null;
            }
          }

          const spanGenuineSpanId = spanSpanID || spanSpanId || undefined;
          if (!allowFallback && !spanGenuineSpanId) {
            return null;
          }
          const sId = spanGenuineSpanId || (allowFallback ? requestedTraceId.slice(0, 16) : "");
          if (!allowFallback && spanMap.has(sId)) {
            return null;
          }
          const pId = rawSpan.parentSpanId || rawSpan.parentSpanID || undefined;
          const startMs = rawSpan.startTimeUnixNano ? Number(BigInt(rawSpan.startTimeUnixNano) / BigInt(1e6)) : Date.now();
          const endMs = rawSpan.endTimeUnixNano ? Number(BigInt(rawSpan.endTimeUnixNano) / BigInt(1e6)) : startMs + 10;
          const duration = Math.max(1, Math.round(endMs - startMs));
          const isErr = rawSpan.status?.code === 2;
          if (isErr) hasErrors = true;

          const attrs: Record<string, unknown> = { "service.name": serviceName };
          for (const a of rawSpan.attributes || []) {
            attrs[a.key] = a.value.stringValue ?? a.value.intValue ?? a.value.boolValue;
          }

          const span: TraceSpan = {
            spanId: sId,
            parentSpanId: pId,
            traceId: spanFinalTraceId,
            operationName: rawSpan.name || "HTTP Operation",
            serviceName,
            startTimeUs: startMs * 1000,
            durationMs: duration,
            statusCode: isErr ? "ERROR" : "OK",
            errorMessage: isErr ? rawSpan.status?.message || "Span status error" : undefined,
            attributes: attrs,
            depth: 0,
            children: [],
          };
          spanMap.set(sId, span);
          allSpans.push(span);
        }
      }
    }

    if (allSpans.length === 0) {
      return allowFallback ? this.createFallbackTrace(backendRootTraceId || requestedTraceId) : null;
    }

    // Build hierarchy and assign depths
    this.linkChildrenAndAssignDepths(allSpans, spanMap);

    if (!allowFallback && (!backendRootTraceId || backendRootTraceId.trim().length === 0)) {
      return null;
    }
    const actualTraceId = backendRootTraceId || (allowFallback ? (allSpans[0]?.traceId || requestedTraceId) : "");
    if (!allowFallback && (!actualTraceId || actualTraceId.trim().length === 0)) {
      return null;
    }
    const rootSpan = allSpans.find((s) => s.depth === 0) || allSpans[0];
    return {
      traceId: actualTraceId,
      rootServiceName: rootSpan.serviceName,
      operationName: rootSpan.operationName,
      startTime: new Date(allSpans[0].startTimeUs / 1000).toISOString(),
      durationMs: rootSpan.durationMs || Math.max(...allSpans.map((s) => s.durationMs)),
      totalSpans: allSpans.length,
      hasErrors,
      servicesInvolved: Array.from(services),
      rootSpan,
      allSpans,
      isFallback: false,
    };
  }

  private createFallbackTrace(traceId: string): DistributedTrace {
    const rootSpan: TraceSpan = {
      spanId: traceId.slice(0, 16),
      traceId,
      operationName: "Cloud Trace",
      serviceName: "cloud-tempo",
      startTimeUs: Date.now() * 1000,
      durationMs: 50,
      statusCode: "OK",
      attributes: { "service.name": "cloud-tempo" },
      depth: 0,
      children: [],
    };
    return {
      traceId,
      rootServiceName: "cloud-tempo",
      operationName: "Cloud Trace",
      startTime: new Date().toISOString(),
      durationMs: 50,
      totalSpans: 1,
      hasErrors: false,
      servicesInvolved: ["cloud-tempo"],
      rootSpan,
      allSpans: [rootSpan],
      isFallback: true,
    };
  }

  public parseTrace(raw: RawJaegerTrace): DistributedTrace {
    const processMap = raw.processes || {};
    const spanMap = new Map<string, TraceSpan>();
    const allSpans: TraceSpan[] = [];
    const servicesSet = new Set<string>();
    let hasErrors = false;

    for (const s of raw.spans) {
      const serviceName =
        s.process?.serviceName ||
        (s.processID ? processMap[s.processID]?.serviceName : undefined) ||
        (s.tags.find((t) => t.key === "service.name")?.value as string) ||
        "unknown-service";

      servicesSet.add(serviceName);
      const tags = s.tags || [];
      const isError = Boolean(tags.find((t) => t.key === "error" && t.value === true));
      if (isError) hasErrors = true;

      const parentRef = s.references?.find((r) => r.refType === "CHILD_OF");
      const parentSpanId = parentRef?.spanID;

      const attributes: Record<string, unknown> = {};
      for (const tag of tags) {
        attributes[tag.key] = tag.value;
      }

      const span: TraceSpan = {
        spanId: s.spanID,
        parentSpanId,
        traceId: s.traceID,
        operationName: s.operationName,
        serviceName,
        startTimeUs: s.startTime,
        durationMs: Math.max(1, Math.round(s.duration / 1000)),
        statusCode: isError ? "ERROR" : "OK",
        errorMessage: isError
          ? (s.tags.find((t) => t.key === "message" || t.key === "error.message")?.value as string) || "Span recorded error status"
          : undefined,
        attributes,
        depth: 0,
        children: [],
      };

      spanMap.set(s.spanID, span);
      allSpans.push(span);
    }

    this.linkChildrenAndAssignDepths(allSpans, spanMap);

    const rootSpan = allSpans.find((s) => s.depth === 0) || allSpans[0];
    const minStartTime = allSpans.reduce((min, s) => Math.min(min, s.startTimeUs), Infinity);
    const totalDurationMs = rootSpan?.durationMs || Math.max(...allSpans.map((s) => s.durationMs), 1);

    return {
      traceId: raw.traceID,
      rootServiceName: rootSpan?.serviceName || allSpans[0]?.serviceName || "unknown",
      operationName: rootSpan?.operationName || allSpans[0]?.operationName || "HTTP Request",
      startTime: minStartTime !== Infinity ? new Date(minStartTime / 1000).toISOString() : new Date().toISOString(),
      durationMs: totalDurationMs,
      totalSpans: allSpans.length,
      hasErrors,
      servicesInvolved: Array.from(servicesSet),
      rootSpan,
      allSpans,
      isFallback: false,
    };
  }

  /**
   * Reconstructs parent-child span relations and calculates hierarchy depths.
   * Gracefully handles missing parents (treated as roots) and prevents cyclic recursion.
   */
  private linkChildrenAndAssignDepths(allSpans: TraceSpan[], spanMap: Map<string, TraceSpan>): void {
    // 1. Link children to parents
    for (const span of allSpans) {
      if (span.parentSpanId && spanMap.has(span.parentSpanId)) {
        const parent = spanMap.get(span.parentSpanId)!;
        if (!parent.children.some((c) => c.spanId === span.spanId)) {
          parent.children.push(span);
        }
      }
    }

    // 2. Identify candidate roots (no parent or parent missing from trace)
    const roots = allSpans.filter((s) => !s.parentSpanId || !spanMap.has(s.parentSpanId));

    // 3. Traverse hierarchy with cycle prevention
    const visited = new Set<string>();

    const assignDepth = (node: TraceSpan, currentDepth: number) => {
      if (visited.has(node.spanId)) return;
      visited.add(node.spanId);
      node.depth = currentDepth;

      for (const child of node.children) {
        assignDepth(child, currentDepth + 1);
      }
    };

    for (const root of roots) {
      assignDepth(root, 0);
    }

    // 4. Safe fallback for any cyclic or unvisited nodes
    for (const span of allSpans) {
      if (!visited.has(span.spanId)) {
        span.depth = 0;
      }
    }
  }
}

export const jaegerClient = new JaegerClient();
