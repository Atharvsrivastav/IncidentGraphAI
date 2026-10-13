import { DistributedTrace, TraceSpan } from "./types";

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
  startTime: number; // in microseconds
  duration: number;  // in microseconds
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

export class JaegerClient {
  private baseUrl: string;
  private timeoutMs: number;
  private isCloud: boolean;
  private authHeader: string | null = null;

  constructor(
    customUrl?: string,
    customTimeoutMs?: number
  ) {
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
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }
    return headers;
  }

  public async checkHealth(): Promise<{ available: boolean; isMock?: boolean; isCloud?: boolean; error?: string }> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      // In Tempo Cloud, probe /api/search?limit=1; in local Jaeger probe /api/traces?limit=1
      const probePath = this.isCloud ? "/api/search?limit=1" : "/api/traces?limit=1";
      const url = `${this.baseUrl}${probePath}`;

      const res = await fetch(url, {
        signal: controller.signal,
        headers: this.getRequestHeaders(),
      });
      clearTimeout(timeout);

      if (res.status === 401 || res.status === 403) {
        return {
          available: false,
          isCloud: this.isCloud,
          error: `Grafana Cloud Tempo authentication failed (${res.status} ${res.statusText}). Verify GRAFANA_CLOUD_TEMPO_USER (instance ID) and read token permission ('traces:read').`,
        };
      }

      const isMock = res.headers.get("x-observability-provider") === "mock-observability-server";
      return { available: res.ok, isMock, isCloud: this.isCloud };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { available: false, isMock: false, isCloud: this.isCloud, error: msg };
    }
  }

  public async getRecentTraces(service?: string, limit: number = 20): Promise<DistributedTrace[]> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      // Support Grafana Cloud Tempo Search and standard Jaeger query
      const url = this.isCloud
        ? `${this.baseUrl}/api/search?limit=${limit}${service ? `&tags=service.name=${encodeURIComponent(service)}` : ""}`
        : `${this.baseUrl}/api/traces?limit=${limit}${service ? `&service=${encodeURIComponent(service)}` : ""}`;

      const res = await fetch(url, {
        signal: controller.signal,
        headers: this.getRequestHeaders(),
      });
      clearTimeout(timeout);

      if (!res.ok) return [];

      const json = await res.json();

      // Case 1: Standard Jaeger response format ({ data: [...] })
      if (Array.isArray(json.data)) {
        const rawTraces: RawJaegerTrace[] = json.data;
        return rawTraces.map((raw) => this.parseTrace(raw));
      }

      // Case 2: Grafana Cloud Tempo Search response format ({ traces: [...] })
      if (Array.isArray(json.traces)) {
        const tempoTraces: TempoSearchTrace[] = json.traces;
        return tempoTraces.map((t) => this.parseTempoSearchTrace(t));
      }

      return [];
    } catch {
      return [];
    }
  }

  public async getTraceById(traceId: string): Promise<DistributedTrace | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      const url = `${this.baseUrl}/api/traces/${encodeURIComponent(traceId)}`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: this.getRequestHeaders(),
      });
      clearTimeout(timeout);

      if (!res.ok) return null;

      const json = await res.json();

      // If Jaeger JSON format
      if (Array.isArray(json.data) && json.data.length > 0) {
        return this.parseTrace(json.data[0]);
      }

      // If Tempo trace object
      if (json.batches || json.spans || json.traceID) {
        return this.parseTempoTraceDetail(json, traceId);
      }

      return null;
    } catch {
      return null;
    }
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

  private parseTempoTraceDetail(json: Record<string, unknown>, traceId: string): DistributedTrace {
    const rootSpan: TraceSpan = {
      spanId: traceId.slice(0, 16),
      traceId,
      operationName: "Cloud Trace",
      serviceName: "cloud-tempo",
      startTimeUs: Date.now() * 1000,
      durationMs: 50,
      statusCode: "OK",
      attributes: json,
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

  private parseTrace(raw: RawJaegerTrace): DistributedTrace {
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
        durationMs: Math.max(1, Math.round(s.duration / 1000)), // microseconds to ms
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

    // Build hierarchy
    let rootSpan: TraceSpan | null = null;
    for (const span of allSpans) {
      if (span.parentSpanId && spanMap.has(span.parentSpanId)) {
        const parent = spanMap.get(span.parentSpanId)!;
        parent.children.push(span);
      } else if (!rootSpan) {
        rootSpan = span;
      }
    }

    const setDepths = (node: TraceSpan, currentDepth: number) => {
      node.depth = currentDepth;
      for (const child of node.children) {
        setDepths(child, currentDepth + 1);
      }
    };
    if (rootSpan) {
      setDepths(rootSpan, 0);
    }

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
}

export const jaegerClient = new JaegerClient();
