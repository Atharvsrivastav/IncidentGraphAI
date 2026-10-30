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

  public async getTraceById(traceId: string): Promise<DistributedTrace | null> {
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
        return this.parseTrace(json.data[0]);
      }
      if (json.batches || json.resourceSpans || json.spans || json.traceID) {
        return this.parseTempoTraceDetail(json, traceId);
      }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
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

    const rootSpan: TraceSpan = {
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

    return {
      traceId: t.traceID,
      rootServiceName: rootService,
      operationName: t.rootTraceName || "HTTP Request",
      startTime: nowIso,
      durationMs: duration,
      totalSpans: t.spanSet?.spans?.length || 1,
      hasErrors: false,
      servicesInvolved: [rootService],
      rootSpan,
      allSpans: [rootSpan],
    };
  }

  public parseTempoTraceDetail(json: Record<string, unknown>, traceId: string): DistributedTrace {
    const batches = (json.batches || json.resourceSpans) as Array<{
      resource?: { attributes?: Array<{ key: string; value: { stringValue?: string } }> };
      scopeSpans?: Array<{
        spans?: Array<{
          traceId?: string;
          spanId?: string;
          parentSpanId?: string;
          name?: string;
          startTimeUnixNano?: string;
          endTimeUnixNano?: string;
          status?: { code?: number; message?: string };
          attributes?: Array<{ key: string; value: { stringValue?: string; intValue?: number; boolValue?: boolean } }>;
        }>;
      }>;
    }>;

    if (!Array.isArray(batches) || batches.length === 0) {
      return this.createFallbackTrace(traceId);
    }

    const allSpans: TraceSpan[] = [];
    const spanMap = new Map<string, TraceSpan>();
    const services = new Set<string>();
    let hasErrors = false;

    for (const batch of batches) {
      const serviceAttr = batch.resource?.attributes?.find((a) => a.key === "service.name");
      const serviceName = serviceAttr?.value?.stringValue || "unknown-service";
      services.add(serviceName);

      for (const scope of batch.scopeSpans || []) {
        for (const rawSpan of scope.spans || []) {
          const sId = rawSpan.spanId || traceId.slice(0, 16);
          const pId = rawSpan.parentSpanId || undefined;
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
            traceId,
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
      return this.createFallbackTrace(traceId);
    }

    // Build hierarchy and assign depths
    this.linkChildrenAndAssignDepths(allSpans, spanMap);

    const rootSpan = allSpans.find((s) => s.depth === 0) || allSpans[0];
    return {
      traceId,
      rootServiceName: rootSpan.serviceName,
      operationName: rootSpan.operationName,
      startTime: new Date(allSpans[0].startTimeUs / 1000).toISOString(),
      durationMs: rootSpan.durationMs || Math.max(...allSpans.map((s) => s.durationMs)),
      totalSpans: allSpans.length,
      hasErrors,
      servicesInvolved: Array.from(services),
      rootSpan,
      allSpans,
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
      const isError = Boolean(s.tags.find((t) => t.key === "error" && t.value === true));
      if (isError) hasErrors = true;

      const parentRef = s.references?.find((r) => r.refType === "CHILD_OF");
      const parentSpanId = parentRef?.spanID;

      const attributes: Record<string, unknown> = {};
      for (const tag of s.tags) {
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
