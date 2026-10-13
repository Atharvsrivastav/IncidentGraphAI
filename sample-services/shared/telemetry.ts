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
}

const initializedServices = new Map<string, ServiceTelemetry>();

export function initServiceTelemetry(serviceName: string): ServiceTelemetry {
  if (initializedServices.has(serviceName)) {
    return initializedServices.get(serviceName)!;
  }

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

  // 1. Trace provider with OTLP HTTP trace exporter
  const traceUrl = otlpEndpoint.endsWith("/v1/traces") ? otlpEndpoint : `${otlpEndpoint}/v1/traces`;
  const traceExporter = new OTLPTraceExporter({
    url: traceUrl,
    headers,
  });

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

  const requestCounter = meter.createCounter("http_requests_total", {
    description: "Total number of HTTP requests processed by this service",
    unit: "1",
  });

  const errorCounter = meter.createCounter("http_request_errors_total", {
    description: "Total number of HTTP error responses (5xx or timeouts)",
    unit: "1",
  });

  const durationHistogram = meter.createHistogram("http_request_duration_seconds", {
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
  };

  initializedServices.set(serviceName, instance);
  return instance;
}
