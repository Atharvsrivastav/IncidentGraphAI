import {
  trace,
  context,
  propagation,
  Span,
  SpanStatusCode,
  Tracer,
  Meter,
  metrics,
  Counter,
  Histogram,
} from "@opentelemetry/api";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

export interface MetricAttributes {
  service?: string;
  status?: string;
  method?: string;
  [key: string]: unknown;
}

function escapeLabelValue(val: string): string {
  return String(val)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

export class PrometheusRegistry {
  private serviceName: string;
  private requests = new Map<string, number>();
  private errors = new Map<string, number>();
  private durations: { sum: number; count: number; buckets: Map<number, number> };
  private healthStatus: number = 1;
  public static readonly BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 10];

  constructor(serviceName: string) {
    this.serviceName = serviceName;
    const bucketMap = new Map<number, number>();
    for (const b of PrometheusRegistry.BUCKETS) {
      bucketMap.set(b, 0);
    }
    this.durations = { sum: 0, count: 0, buckets: bucketMap };
  }

  public setHealthStatus(status: number | boolean | "HEALTHY" | "DEGRADED" | "DOWN"): void {
    if (typeof status === "number") {
      this.healthStatus = status <= 0 ? 0 : 1;
    } else if (typeof status === "boolean") {
      this.healthStatus = status ? 1 : 0;
    } else if (status === "HEALTHY") {
      this.healthStatus = 1;
    } else {
      this.healthStatus = 0;
    }
  }

  public getHealthStatus(): number {
    return this.healthStatus;
  }

  public recordRequest(count: number = 1, attributes?: MetricAttributes): void {
    if (typeof count !== "number" || isNaN(count) || count < 0) {
      throw new Error(`Invalid metric count: ${count}`);
    }
    const rawStatus = String(attributes?.status ?? "200");
    const status = /^\d{3}$/.test(rawStatus) ? rawStatus : "unknown";
    const extraVerification = attributes?.verification_id
      ? `,verification_id="${escapeLabelValue(String(attributes.verification_id))}"`
      : "";
    const key = `service="${escapeLabelValue(this.serviceName)}",status="${escapeLabelValue(status)}"${extraVerification}`;
    this.requests.set(key, (this.requests.get(key) || 0) + count);
  }

  public recordError(count: number = 1, attributes?: MetricAttributes): void {
    if (typeof count !== "number" || isNaN(count) || count < 0) {
      throw new Error(`Invalid error count: ${count}`);
    }
    const rawStatus = String(attributes?.status ?? "500");
    const status = /^\d{3}$/.test(rawStatus) ? rawStatus : "500";
    const key = `service="${escapeLabelValue(this.serviceName)}",status="${escapeLabelValue(status)}"`;
    this.errors.set(key, (this.errors.get(key) || 0) + count);
  }

  public recordDuration(seconds: number): void {
    if (typeof seconds !== "number" || isNaN(seconds) || seconds < 0) {
      throw new Error(`Invalid duration seconds: ${seconds}`);
    }
    this.durations.sum += seconds;
    this.durations.count += 1;
    for (const b of PrometheusRegistry.BUCKETS) {
      if (seconds <= b) {
        this.durations.buckets.set(b, (this.durations.buckets.get(b) || 0) + 1);
      }
    }
  }

  public toPrometheusFormat(): string {
    const lines: string[] = [];

    // http_requests_total
    lines.push("# HELP http_requests_total Total number of HTTP requests processed by this service");
    lines.push("# TYPE http_requests_total counter");
    if (this.requests.size === 0) {
      lines.push(`http_requests_total{service="${escapeLabelValue(this.serviceName)}",status="200"} 0`);
    } else {
      for (const [labels, val] of this.requests.entries()) {
        lines.push(`http_requests_total{${labels}} ${val}`);
      }
    }

    // http_request_errors_total
    lines.push("# HELP http_request_errors_total Total number of HTTP error responses (5xx or timeouts)");
    lines.push("# TYPE http_request_errors_total counter");
    if (this.errors.size === 0) {
      lines.push(`http_request_errors_total{service="${escapeLabelValue(this.serviceName)}",status="500"} 0`);
    } else {
      for (const [labels, val] of this.errors.entries()) {
        lines.push(`http_request_errors_total{${labels}} ${val}`);
      }
    }

    // http_request_duration_seconds
    lines.push("# HELP http_request_duration_seconds Duration of HTTP request processing in seconds");
    lines.push("# TYPE http_request_duration_seconds histogram");
    for (const b of PrometheusRegistry.BUCKETS) {
      const count = this.durations.buckets.get(b) || 0;
      lines.push(`http_request_duration_seconds_bucket{service="${escapeLabelValue(this.serviceName)}",le="${b}"} ${count}`);
    }
    lines.push(`http_request_duration_seconds_bucket{service="${escapeLabelValue(this.serviceName)}",le="+Inf"} ${this.durations.count}`);
    lines.push(`http_request_duration_seconds_sum{service="${escapeLabelValue(this.serviceName)}"} ${this.durations.sum.toFixed(6)}`);
    lines.push(`http_request_duration_seconds_count{service="${escapeLabelValue(this.serviceName)}"} ${this.durations.count}`);

    // service_health_status
    lines.push("# HELP service_health_status Health status of the service (1=healthy, 0=unhealthy)");
    lines.push("# TYPE service_health_status gauge");
    lines.push(`service_health_status{service="${escapeLabelValue(this.serviceName)}"} ${this.healthStatus}`);

    return lines.join("\n") + "\n";
  }
}

export interface ServiceTelemetry {
  tracer: Tracer;
  meter: Meter;
  requestCounter: Counter;
  errorCounter: Counter;
  durationHistogram: Histogram;
  log: (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void;
  startSpan: (name: string, carrier?: Record<string, string>) => { span: Span; ctx: ReturnType<typeof context.active> };
  injectTraceContext: (carrier?: Record<string, string>, explicitSpan?: Span) => Record<string, string>;
  endSpan: (span: Span, statusCode?: SpanStatusCode, errorMessage?: string) => void;
  isCloudExportEnabled: boolean;
  otlpTargetUrl: string;
  getPrometheusMetrics: () => string;
  handleMetricsRequest: (res: import("http").ServerResponse) => void;
  setHealthStatus: (status: number | boolean | "HEALTHY" | "DEGRADED" | "DOWN") => void;
  getHealthStatus: () => number;
  getExportStatus: () => {
    isCloudExport: boolean;
    lastExportStatus: "SUCCESS" | "FAILED" | "PENDING" | "DISABLED";
    lastExportTime?: string;
    lastExportError?: string;
    successCount: number;
    failureCount: number;
  };
}

const initializedServices = new Map<string, ServiceTelemetry>();

export function initServiceTelemetry(serviceName: string): ServiceTelemetry {
  if (initializedServices.has(serviceName)) {
    return initializedServices.get(serviceName)!;
  }

  const registry = new PrometheusRegistry(serviceName);

  // Determine OTLP endpoint: Grafana Cloud takes precedence if configured
  const otlpEndpoint = (
    process.env.GRAFANA_CLOUD_OTLP_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    "http://localhost:4318"
  ).replace(/\/$/, "");

  // Build secure authentication headers
  const headers: Record<string, string> = {};

  const grafanaInstanceId = process.env.GRAFANA_CLOUD_INSTANCE_ID || process.env.GRAFANA_CLOUD_OTLP_INSTANCE_ID;
  const grafanaToken = process.env.GRAFANA_CLOUD_INGESTION_TOKEN;

  if (grafanaInstanceId && grafanaToken) {
    const credentials = Buffer.from(`${grafanaInstanceId.trim()}:${grafanaToken.trim()}`).toString("base64");
    headers["Authorization"] = `Basic ${credentials}`;
  }

  if (process.env.OTEL_EXPORTER_OTLP_HEADERS) {
    for (const pair of process.env.OTEL_EXPORTER_OTLP_HEADERS.split(",")) {
      const [k, ...v] = pair.split("=");
      if (k && v.length) {
        headers[k.trim()] = v.join("=").trim();
      }
    }
  }

  const isCloudExport = otlpEndpoint.startsWith("https://");

  // Resource metadata
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: "1.0.0",
    "deployment.environment": process.env.DEPLOYMENT_ENVIRONMENT || process.env.ENVIRONMENT || (isCloudExport ? "production-hosted" : "development"),
  });

  // Track genuine exporter outcomes
  const exportTracker = {
    status: (isCloudExport ? "PENDING" : "DISABLED") as "SUCCESS" | "FAILED" | "PENDING" | "DISABLED",
    lastTime: undefined as string | undefined,
    lastError: undefined as string | undefined,
    successCount: 0,
    failureCount: 0,
  };

  // 1. Trace provider with OTLP HTTP trace exporter
  const traceUrl = otlpEndpoint.endsWith("/v1/traces") ? otlpEndpoint : `${otlpEndpoint}/v1/traces`;
  const traceExporter = new OTLPTraceExporter({
    url: traceUrl,
    headers,
  });

  // Intercept trace exporter callback to track genuine live outcomes
  const origTraceExport = traceExporter.export.bind(traceExporter);
  traceExporter.export = (spans, resultCallback) => {
    origTraceExport(spans, (result) => {
      if (result.code === 0) {
        exportTracker.status = "SUCCESS";
        exportTracker.lastTime = new Date().toISOString();
        exportTracker.lastError = undefined;
        exportTracker.successCount++;
      } else {
        exportTracker.status = "FAILED";
        exportTracker.lastError = result.error?.message || "OTLP trace export failed";
        exportTracker.failureCount++;
      }
      resultCallback(result);
    });
  };

  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor(traceExporter)],
  });
  provider.register();

  // 2. Metric provider with OTLP HTTP metric exporter
  const metricUrl = otlpEndpoint.endsWith("/v1/metrics") ? otlpEndpoint : `${otlpEndpoint}/v1/metrics`;
  const metricExporter = new OTLPMetricExporter({
    url: metricUrl,
    headers,
  });

  // Intercept metric exporter callback to track genuine live outcomes
  const origMetricExport = metricExporter.export.bind(metricExporter);
  metricExporter.export = (metricsData, resultCallback) => {
    origMetricExport(metricsData, (result) => {
      if (result.code === 0) {
        exportTracker.status = "SUCCESS";
        exportTracker.lastTime = new Date().toISOString();
        exportTracker.lastError = undefined;
        exportTracker.successCount++;
      } else {
        exportTracker.status = "FAILED";
        exportTracker.lastError = result.error?.message || "OTLP metric export failed";
        exportTracker.failureCount++;
      }
      resultCallback(result);
    });
  };

  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 3000,
  });

  const meterProvider = new MeterProvider({
    resource,
    readers: [metricReader],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const tracer = trace.getTracer(serviceName, "1.0.0");
  const meter = metrics.getMeter(serviceName, "1.0.0");

  const rawRequestCounter = meter.createCounter("http_requests_total", {
    description: "Total number of HTTP requests processed by this service",
    unit: "1",
  });

  const rawErrorCounter = meter.createCounter("http_request_errors_total", {
    description: "Total number of HTTP error responses (5xx or timeouts)",
    unit: "1",
  });

  const rawDurationHistogram = meter.createHistogram("http_request_duration_seconds", {
    description: "Duration of HTTP request processing in seconds",
    unit: "s",
  });

  const log = (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => {
    const activeSpan = trace.getSpan(context.active());
    const spanContext = activeSpan?.spanContext();
    const payload = {
      timestamp: new Date().toISOString(),
      level,
      serviceName,
      traceId: spanContext?.traceId ?? "none",
      spanId: spanContext?.spanId ?? "none",
      message,
      ...(extra ?? {}),
    };
    // Safe structured logging without logging credentials or secrets
    if (level === "error") {
      console.error(JSON.stringify(payload));
    } else if (level === "warn") {
      console.warn(JSON.stringify(payload));
    } else {
      console.log(JSON.stringify(payload));
    }
  };

  const requestCounter: Counter = {
    add: (value: number, attributes?: Record<string, unknown>) => {
      registry.recordRequest(value, attributes as MetricAttributes);
      try {
        rawRequestCounter.add(value, attributes as Record<string, string | number | boolean>);
      } catch (err: unknown) {
        log("warn", "OTel counter.add failed", { error: err instanceof Error ? err.message : String(err) });
      }
    },
  };

  const errorCounter: Counter = {
    add: (value: number, attributes?: Record<string, unknown>) => {
      registry.recordError(value, attributes as MetricAttributes);
      try {
        rawErrorCounter.add(value, attributes as Record<string, string | number | boolean>);
      } catch (err: unknown) {
        log("warn", "OTel errorCounter.add failed", { error: err instanceof Error ? err.message : String(err) });
      }
    },
  };

  const durationHistogram: Histogram = {
    record: (value: number, attributes?: Record<string, unknown>) => {
      registry.recordDuration(value);
      try {
        rawDurationHistogram.record(value, attributes as Record<string, string | number | boolean>);
      } catch (err: unknown) {
        log("warn", "OTel durationHistogram.record failed", { error: err instanceof Error ? err.message : String(err) });
      }
    },
  };

  const startSpan = (name: string, carrier?: Record<string, string>) => {
    let parentCtx = context.active();
    if (carrier) {
      parentCtx = propagation.extract(parentCtx, carrier);
    }
    const span = tracer.startSpan(name, undefined, parentCtx);
    const activeCtx = trace.setSpan(parentCtx, span);
    return { span, ctx: activeCtx };
  };

  const injectTraceContext = (carrier: Record<string, string> = {}, explicitSpan?: Span) => {
    let targetCtx = context.active();
    if (explicitSpan) {
      targetCtx = trace.setSpan(targetCtx, explicitSpan);
    }
    propagation.inject(targetCtx, carrier);
    return carrier;
  };

  const endSpan = (span: Span, statusCode: SpanStatusCode = SpanStatusCode.OK, errorMessage?: string) => {
    span.setStatus({
      code: statusCode,
      message: errorMessage,
    });
    span.end();
  };

  const getPrometheusMetrics = () => registry.toPrometheusFormat();

  const handleMetricsRequest = (res: import("http").ServerResponse) => {
    res.writeHead(200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
    res.end(registry.toPrometheusFormat());
  };

  const setHealthStatus = (status: number | boolean | "HEALTHY" | "DEGRADED" | "DOWN") => {
    registry.setHealthStatus(status);
  };

  const getHealthStatus = () => registry.getHealthStatus();

  const getExportStatus = () => ({
    isCloudExport,
    lastExportStatus: exportTracker.status,
    lastExportTime: exportTracker.lastTime,
    lastExportError: exportTracker.lastError,
    successCount: exportTracker.successCount,
    failureCount: exportTracker.failureCount,
  });

  const instance: ServiceTelemetry = {
    tracer,
    meter,
    requestCounter,
    errorCounter,
    durationHistogram,
    log,
    startSpan,
    injectTraceContext,
    endSpan,
    isCloudExportEnabled: isCloudExport,
    otlpTargetUrl: traceUrl,
    getPrometheusMetrics,
    handleMetricsRequest,
    setHealthStatus,
    getHealthStatus,
    getExportStatus,
  };

  initializedServices.set(serviceName, instance);
  return instance;
}
