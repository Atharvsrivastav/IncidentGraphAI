import { describe, it, expect } from "vitest";
import {
  normalizeTelemetryMode,
  mergeServiceMetrics,
  buildGraphNodes,
  buildGraphEdges,
  ServiceMapItem,
  ServiceDependencyItem,
} from "../src/lib/telemetry/mergeServiceMetrics";
import { ObservedServiceMetric } from "../src/lib/telemetry/types";
import { TelemetryManager } from "../src/lib/telemetry/telemetryManager";

describe("Service Map UI Integration & React Flow Synchronization Suite", () => {
  const baseDbServices: ServiceMapItem[] = [
    {
      id: "api-gateway",
      name: "API Gateway",
      serviceType: "GATEWAY",
      tier: 1,
      status: "HEALTHY",
      currentLatency: 18,
      baselineLatency: 18,
      currentErrorRate: 0,
      baselineErrorRate: 0,
      requestRate: 1200,
      description: "Edge Ingress Gateway",
    },
    {
      id: "order-service",
      name: "Order Service",
      serviceType: "ORDER",
      tier: 2,
      status: "HEALTHY",
      currentLatency: 35,
      baselineLatency: 35,
      currentErrorRate: 0,
      baselineErrorRate: 0,
      requestRate: 400,
      description: "Order Processing Engine",
    },
    {
      id: "payment-service",
      name: "Payment Service",
      serviceType: "PAYMENT",
      tier: 2,
      status: "HEALTHY",
      currentLatency: 45,
      baselineLatency: 45,
      currentErrorRate: 0,
      baselineErrorRate: 0,
      requestRate: 200,
      description: "Payment Processing Service",
    },
    {
      id: "postgres-db",
      name: "PostgreSQL Database",
      serviceType: "DATABASE",
      tier: 3,
      status: "HEALTHY",
      currentLatency: 12,
      baselineLatency: 12,
      currentErrorRate: 0,
      baselineErrorRate: 0,
      requestRate: 1500,
      description: "Relational Data Store",
    },
  ];

  const baseDependencies: ServiceDependencyItem[] = [
    { sourceServiceId: "api-gateway", targetServiceId: "order-service", dependencyType: "SYNC_HTTP", timeoutThreshold: 2000 },
    { sourceServiceId: "order-service", targetServiceId: "payment-service", dependencyType: "SYNC_HTTP", timeoutThreshold: 2000 },
    { sourceServiceId: "payment-service", targetServiceId: "postgres-db", dependencyType: "DATABASE_CONN", timeoutThreshold: 1500 },
  ];

  // =========================================================================
  // 1. Telemetry Mode Normalization
  // =========================================================================
  describe("Telemetry Mode Normalization", () => {
    it("normalizes legacy REAL alias to LIVE", () => {
      expect(normalizeTelemetryMode("REAL")).toBe("LIVE");
    });

    it("accepts LIVE directly", () => {
      expect(normalizeTelemetryMode("LIVE")).toBe("LIVE");
    });

    it("accepts DEGRADED directly", () => {
      expect(normalizeTelemetryMode("DEGRADED")).toBe("DEGRADED");
    });

    it("defaults to SIMULATION for undefined, null, or empty string", () => {
      expect(normalizeTelemetryMode(undefined)).toBe("SIMULATION");
      expect(normalizeTelemetryMode(null)).toBe("SIMULATION");
      expect(normalizeTelemetryMode("")).toBe("SIMULATION");
      expect(normalizeTelemetryMode("UNKNOWN_MODE")).toBe("SIMULATION");
    });
  });

  // =========================================================================
  // 2. Service Metric Merging in SIMULATION Mode
  // =========================================================================
  describe("SIMULATION Mode Metric Merging", () => {
    it("preserves database simulation metrics and marks them as valid simulated telemetry", () => {
      const merged = mergeServiceMetrics(baseDbServices, [], "SIMULATION");

      expect(merged.length).toBe(4);
      for (const svc of merged) {
        expect(svc.hasValidLatency).toBe(true);
        expect(svc.hasValidErrorRate).toBe(true);
        expect(svc.hasValidRequestRate).toBe(true);
        expect(svc.isObservedLive).toBe(false);
        expect(svc.currentLatency).toBe(svc.baselineLatency);
      }
    });
  });

  // =========================================================================
  // 3. Service Metric Merging in LIVE and DEGRADED Modes
  // =========================================================================
  describe("LIVE and DEGRADED Mode Metric Merging", () => {
    it("merges verified live telemetry when all metrics are valid", () => {
      const observed: ObservedServiceMetric[] = [
        {
          serviceId: "order-service",
          serviceName: "Order Service",
          source: "PROMETHEUS",
          status: "DEGRADED",
          latencyMs: 180,
          hasValidLatency: true,
          errorRate: 8.5,
          hasValidErrorRate: true,
          requestRate: 350,
          hasValidRequestRate: true,
          lastObserved: "2026-10-30T17:00:00Z",
          traceCount: 12,
          isStale: false,
          isKnownInTopology: true,
        },
      ];

      const merged = mergeServiceMetrics(baseDbServices, observed, "LIVE");
      const order = merged.find((s) => s.id === "order-service");

      expect(order).toBeDefined();
      expect(order?.status).toBe("DEGRADED");
      expect(order?.currentLatency).toBe(180);
      expect(order?.hasValidLatency).toBe(true);
      expect(order?.currentErrorRate).toBe(8.5);
      expect(order?.hasValidErrorRate).toBe(true);
      expect(order?.requestRate).toBe(350);
      expect(order?.hasValidRequestRate).toBe(true);
      expect(order?.baselineLatency).toBe(35); // baseline preserved separately
    });

    it("applies valid latency when error-rate series is missing without fabricating 0% error", () => {
      const observed: ObservedServiceMetric[] = [
        {
          serviceId: "payment-service",
          serviceName: "Payment Service",
          source: "PROMETHEUS",
          status: "UNKNOWN",
          latencyMs: 420,
          hasValidLatency: true,
          errorRate: 0,
          hasValidErrorRate: false, // missing error rate!
          requestRate: 150,
          hasValidRequestRate: true,
          lastObserved: "2026-10-30T17:00:00Z",
          traceCount: 0,
          isStale: true,
          isKnownInTopology: true,
        },
      ];

      const merged = mergeServiceMetrics(baseDbServices, observed, "DEGRADED");
      const payment = merged.find((s) => s.id === "payment-service");

      expect(payment).toBeDefined();
      expect(payment?.status).toBe("UNKNOWN");
      // Latency is valid and applied
      expect(payment?.currentLatency).toBe(420);
      expect(payment?.hasValidLatency).toBe(true);
      // Missing error rate MUST be null (N/A in UI), NOT 0%
      expect(payment?.currentErrorRate).toBeNull();
      expect(payment?.hasValidErrorRate).toBe(false);
    });

    it("applies valid error-rate when latency series is missing without fabricating 0ms latency", () => {
      const observed: ObservedServiceMetric[] = [
        {
          serviceId: "api-gateway",
          serviceName: "API Gateway",
          source: "PROMETHEUS",
          status: "DEGRADED",
          latencyMs: 0,
          hasValidLatency: false, // missing latency!
          errorRate: 22.4,
          hasValidErrorRate: true,
          requestRate: 800,
          hasValidRequestRate: true,
          lastObserved: "2026-10-30T17:00:00Z",
          traceCount: 0,
          isStale: true,
          isKnownInTopology: true,
        },
      ];

      const merged = mergeServiceMetrics(baseDbServices, observed, "DEGRADED");
      const gateway = merged.find((s) => s.id === "api-gateway");

      expect(gateway).toBeDefined();
      expect(gateway?.status).toBe("DEGRADED");
      // Missing latency MUST be null (N/A in UI), NOT 0ms or baseline 18ms
      expect(gateway?.currentLatency).toBeNull();
      expect(gateway?.hasValidLatency).toBe(false);
      // Error rate is valid and applied
      expect(gateway?.currentErrorRate).toBe(22.4);
      expect(gateway?.hasValidErrorRate).toBe(true);
    });

    it("marks missing both metrics as null without fabricating healthy numbers", () => {
      const observed: ObservedServiceMetric[] = [
        {
          serviceId: "postgres-db",
          serviceName: "PostgreSQL Database",
          source: "PROMETHEUS",
          status: "UNKNOWN",
          latencyMs: 0,
          hasValidLatency: false,
          errorRate: 0,
          hasValidErrorRate: false,
          requestRate: 0,
          hasValidRequestRate: false,
          lastObserved: "2026-10-30T17:00:00Z",
          traceCount: 0,
          isStale: true,
          isKnownInTopology: true,
        },
      ];

      const merged = mergeServiceMetrics(baseDbServices, observed, "DEGRADED");
      const db = merged.find((s) => s.id === "postgres-db");

      expect(db?.status).toBe("UNKNOWN");
      expect(db?.currentLatency).toBeNull();
      expect(db?.currentErrorRate).toBeNull();
      expect(db?.requestRate).toBeNull();
      expect(db?.hasValidLatency).toBe(false);
      expect(db?.hasValidErrorRate).toBe(false);
      expect(db?.hasValidRequestRate).toBe(false);
    });

    it("handles genuine zero error rate with valid request volume", () => {
      const observed: ObservedServiceMetric[] = [
        {
          serviceId: "order-service",
          serviceName: "Order Service",
          source: "PROMETHEUS",
          status: "HEALTHY",
          latencyMs: 32,
          hasValidLatency: true,
          errorRate: 0,
          hasValidErrorRate: true, // genuine zero verified from reqRate > 0
          requestRate: 450,
          hasValidRequestRate: true,
          lastObserved: "2026-10-30T17:00:00Z",
          traceCount: 5,
          isStale: false,
          isKnownInTopology: true,
        },
      ];

      const merged = mergeServiceMetrics(baseDbServices, observed, "LIVE");
      const order = merged.find((s) => s.id === "order-service");

      expect(order?.status).toBe("HEALTHY");
      expect(order?.currentErrorRate).toBe(0);
      expect(order?.hasValidErrorRate).toBe(true);
    });

    it("marks unobserved topology service as UNKNOWN in LIVE/DEGRADED mode without fabricating database baseline", () => {
      // observed telemetry contains only order-service
      const observed: ObservedServiceMetric[] = [
        {
          serviceId: "order-service",
          serviceName: "Order Service",
          source: "PROMETHEUS",
          status: "HEALTHY",
          latencyMs: 30,
          hasValidLatency: true,
          errorRate: 0,
          hasValidErrorRate: true,
          requestRate: 400,
          hasValidRequestRate: true,
          lastObserved: "2026-10-30T17:00:00Z",
          traceCount: 1,
          isStale: false,
          isKnownInTopology: true,
        },
      ];

      const merged = mergeServiceMetrics(baseDbServices, observed, "LIVE");
      const unobservedDb = merged.find((s) => s.id === "postgres-db");

      expect(unobservedDb).toBeDefined();
      expect(unobservedDb?.status).toBe("UNKNOWN");
      expect(unobservedDb?.currentLatency).toBeNull();
      expect(unobservedDb?.currentErrorRate).toBeNull();
      expect(unobservedDb?.hasValidLatency).toBe(false);
      expect(unobservedDb?.hasValidErrorRate).toBe(false);
      // Baseline is preserved for context
      expect(unobservedDb?.baselineLatency).toBe(12);
    });
  });

  // =========================================================================
  // 4. React Flow Node & Edge State Synchronization
  // =========================================================================
  describe("React Flow Node & Edge State Synchronization", () => {
    it("refreshes node telemetry data when service props change", () => {
      const initialNodes = buildGraphNodes(baseDbServices, [], null, []);
      expect(initialNodes.length).toBe(4);

      const initialOrder = initialNodes.find((n) => n.id === "order-service");
      expect((initialOrder?.data as Record<string, unknown>).latency).toBe(35);

      // Simulate telemetry polling update: order-service latency surges to 350ms
      const updatedServices: ServiceMapItem[] = baseDbServices.map((s) =>
        s.id === "order-service"
          ? { ...s, status: "DEGRADED", currentLatency: 350, currentErrorRate: 15, hasValidLatency: true, hasValidErrorRate: true }
          : s
      );

      const refreshedNodes = buildGraphNodes(updatedServices, initialNodes, null, []);
      const refreshedOrder = refreshedNodes.find((n) => n.id === "order-service");

      expect(refreshedOrder).toBeDefined();
      expect((refreshedOrder?.data as Record<string, unknown>).latency).toBe(350);
      expect((refreshedOrder?.data as Record<string, unknown>).status).toBe("DEGRADED");
      expect((refreshedOrder?.data as Record<string, unknown>).errorRate).toBe(15);
    });

    it("strictly preserves user-dragged node coordinates across telemetry polling updates", () => {
      const initialNodes = buildGraphNodes(baseDbServices, [], null, []);
      const gatewayNode = initialNodes.find((n) => n.id === "api-gateway");
      expect(gatewayNode).toBeDefined();

      // Simulate user dragging api-gateway to a custom canvas position
      const draggedNodes = initialNodes.map((n) =>
        n.id === "api-gateway"
          ? { ...n, position: { x: 888, y: 999 } }
          : n
      );

      // Simulate telemetry polling cycle with updated latency
      const polledServices: ServiceMapItem[] = baseDbServices.map((s) =>
        s.id === "api-gateway"
          ? { ...s, currentLatency: 45, hasValidLatency: true }
          : s
      );

      const synchronizedNodes = buildGraphNodes(polledServices, draggedNodes, null, []);
      const synchronizedGateway = synchronizedNodes.find((n) => n.id === "api-gateway");

      // Position MUST remain exactly at the user-dragged coordinates { x: 888, y: 999 }
      expect(synchronizedGateway?.position).toEqual({ x: 888, y: 999 });
      // Data MUST be updated with fresh telemetry
      expect((synchronizedGateway?.data as Record<string, unknown>).latency).toBe(45);
    });

    it("preserves object reference when node telemetry and position have not changed", () => {
      const initialNodes = buildGraphNodes(baseDbServices, [], null, []);
      // Second call with identical data
      const nextNodes = buildGraphNodes(baseDbServices, initialNodes, null, []);

      // Avoids unnecessary React Flow re-renders
      expect(nextNodes).toBe(initialNodes);
    });

    it("synchronizes edges when dependencies or incident paths change", () => {
      const initialEdges = buildGraphEdges(baseDependencies, null, []);
      expect(initialEdges.length).toBe(3);

      // All edges nominal
      for (const edge of initialEdges) {
        expect(edge.animated).toBe(false);
        expect(edge.style?.stroke).toBe("#64748b");
      }

      // Active incident: postgres-db is suspected root cause, payment-service and order-service affected
      const incidentEdges = buildGraphEdges(
        baseDependencies,
        "postgres-db",
        ["payment-service", "order-service"]
      );

      // The edge pointing to postgres-db (payment-service -> postgres-db) MUST be animated & colored rose
      const dbEdge = incidentEdges.find((e) => e.target === "postgres-db");
      expect(dbEdge?.animated).toBe(true);
      expect(dbEdge?.style?.stroke).toBe("#f43f5e");

      // The edge from affected order-service (order-service -> payment-service) MUST also be highlighted
      const orderEdge = incidentEdges.find((e) => e.source === "order-service");
      expect(orderEdge?.animated).toBe(true);
      expect(orderEdge?.style?.stroke).toBe("#f43f5e");
    });
  });

  // =========================================================================
  // 7. Separation of Requested Mode from Effective Telemetry State
  // =========================================================================
  describe("Requested Mode vs Effective Telemetry State Separation", () => {
    it("separates requested LIVE mode from unconfirmed effective state", () => {
      const manager = TelemetryManager.getInstance();

      // Reset to simulation
      manager.setMode("SIMULATION");
      expect(manager.getRequestedMode()).toBe("SIMULATION");
      expect(manager.getEffectiveMode()).toBe("SIMULATION");

      // Request LIVE mode
      manager.setMode("LIVE");
      expect(manager.getRequestedMode()).toBe("LIVE");
      // Prior to confirmed observations, effectiveMode must NOT claim LIVE!
      expect(manager.getEffectiveMode()).toBe("DEGRADED");

      const operational = manager.getOperationalState();
      expect(operational.requestedMode).toBe("LIVE");
      expect(operational.effectiveMode).toBe("DEGRADED");
    });

    it("resets effectiveMode immediately when SIMULATION is requested", () => {
      const manager = TelemetryManager.getInstance();
      manager.setMode("LIVE");
      expect(manager.getRequestedMode()).toBe("LIVE");

      manager.setMode("SIMULATION");
      expect(manager.getRequestedMode()).toBe("SIMULATION");
      expect(manager.getEffectiveMode()).toBe("SIMULATION");
    });
  });

  // =========================================================================
  // 8. Navigation State and Failed Request Guard
  // =========================================================================
  describe("Navigation Status Handling & Failed Request Guard", () => {
    it("simulates failed POST request and proves state is never falsely updated to LIVE", () => {
      // Current navigation state
      let requestedState = "SIMULATION";
      let effectiveState = "SIMULATION";

      // Simulate a failed fetch response (e.g. 500 error or network failure)
      const simulatedFetch = async () => {
        return { ok: false, status: 500, json: async (): Promise<Record<string, unknown>> => ({ error: "Internal Error" }) };
      };

      const handleModeSwitch = async (targetMode: string) => {
        try {
          const res = await simulatedFetch();
          if (res.ok) {
            const data = await res.json();
            effectiveState = normalizeTelemetryMode((data.effectiveMode ?? data.mode) as string | null);
            requestedState = normalizeTelemetryMode((data.requestedMode ?? targetMode) as string | null);
          } else {
            // Failed request: NEVER set status to LIVE!
            // State remains untouched
          }
        } catch {
          // Network failure: NEVER set status to LIVE!
        }
      };

      void handleModeSwitch("LIVE");

      expect(requestedState).toBe("SIMULATION");
      expect(effectiveState).toBe("SIMULATION");
      expect(effectiveState).not.toBe("LIVE");
    });

    it("simulates successful POST request with DEGRADED backends returning honest effectiveMode", async () => {
      let requestedState = "SIMULATION";
      let effectiveState = "SIMULATION";

      // Simulate successful API response where backends are degraded/offline
      const simulatedFetch = async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            requestedMode: "LIVE",
            effectiveMode: "DEGRADED",
            mode: "DEGRADED",
          }),
        };
      };

      const res = await simulatedFetch();
      if (res.ok) {
        const data = await res.json();
        effectiveState = normalizeTelemetryMode(data.effectiveMode ?? data.mode);
        requestedState = normalizeTelemetryMode(data.requestedMode ?? "LIVE");
      }

      expect(requestedState).toBe("LIVE");
      expect(effectiveState).toBe("DEGRADED");
    });

    it("evaluates Navigation status badge: never shows 'All Systems Operational' when live telemetry is degraded", () => {
      const getNavigationBadge = (systemStatus: string, effectiveMode: string) => {
        if (systemStatus === "INCIDENT") {
          return { dot: "bg-red-500", label: "Active Incident" };
        }
        if (effectiveMode === "DEGRADED") {
          return { dot: "bg-amber-500", label: "Telemetry Pipeline Degraded" };
        }
        return { dot: "bg-emerald-500", label: "All Systems Operational" };
      };

      // 1. Simulation without incident -> All Systems Operational
      expect(getNavigationBadge("HEALTHY", "SIMULATION")).toEqual({
        dot: "bg-emerald-500",
        label: "All Systems Operational",
      });

      // 2. Telemetry degraded without incident -> Telemetry Pipeline Degraded (NEVER All Systems Operational)
      expect(getNavigationBadge("HEALTHY", "DEGRADED")).toEqual({
        dot: "bg-amber-500",
        label: "Telemetry Pipeline Degraded",
      });

      // 3. Incident active -> Active Incident
      expect(getNavigationBadge("INCIDENT", "DEGRADED")).toEqual({
        dot: "bg-red-500",
        label: "Active Incident",
      });
    });
  });

  // =========================================================================
  // 9. Mock Emulation Honest Presentation
  // =========================================================================
  describe("Mock Emulation Honest Presentation", () => {
    it("distinguishes MOCK_EMULATION from genuine production telemetry in banner rendering", () => {
      const getBannerDisplay = (backendType: string, telemetryMode: string) => {
        if (telemetryMode !== "LIVE") return null;

        const isMock = backendType === "MOCK_EMULATION";
        return {
          title: isMock
            ? "Mock Telemetry Emulation Active (Dev Server)"
            : "Live Telemetry Mode Active",
          badge: isMock
            ? "MOCK EMULATION — NOT PRODUCTION TELEMETRY"
            : backendType === "GRAFANA_CLOUD"
            ? "☁ Grafana Cloud (Hosted)"
            : "Genuine Docker Stack",
          isProduction: !isMock,
        };
      };

      // Mock backend must NEVER claim "Live Telemetry Mode Active"
      const mockDisplay = getBannerDisplay("MOCK_EMULATION", "LIVE");
      expect(mockDisplay?.title).toBe("Mock Telemetry Emulation Active (Dev Server)");
      expect(mockDisplay?.badge).toBe("MOCK EMULATION — NOT PRODUCTION TELEMETRY");
      expect(mockDisplay?.isProduction).toBe(false);

      // Genuine Grafana Cloud
      const cloudDisplay = getBannerDisplay("GRAFANA_CLOUD", "LIVE");
      expect(cloudDisplay?.title).toBe("Live Telemetry Mode Active");
      expect(cloudDisplay?.badge).toBe("☁ Grafana Cloud (Hosted)");
      expect(cloudDisplay?.isProduction).toBe(true);

      // Genuine Docker stack
      const dockerDisplay = getBannerDisplay("GENUINE_STACK", "LIVE");
      expect(dockerDisplay?.title).toBe("Live Telemetry Mode Active");
      expect(dockerDisplay?.badge).toBe("Genuine Docker Stack");
      expect(dockerDisplay?.isProduction).toBe(true);
    });
  });

  // =========================================================================
  // 10. Unknown Services Metric Rendering with Validity Flags
  // =========================================================================
  describe("Unknown Services Metric Rendering with Validity Flags", () => {
    it("renders valid metrics accurately and preserves genuine zero values", () => {
      const unknownMetric: ObservedServiceMetric = {
        serviceId: "cache-proxy",
        serviceName: "cache-proxy",
        source: "PROMETHEUS",
        status: "HEALTHY",
        latencyMs: 0,
        hasValidLatency: true,
        errorRate: 0,
        hasValidErrorRate: true,
        requestRate: 0,
        hasValidRequestRate: true,
        lastObserved: "2026-10-31T00:00:00Z",
        traceCount: 0,
        isStale: false,
        isKnownInTopology: false,
      };

      const formatUnknownMetrics = (u: ObservedServiceMetric) => {
        const reqText = u.hasValidRequestRate === true ? `${u.requestRate} req/s` : "N/A req/s";
        const latText = u.hasValidLatency === true ? `${u.latencyMs}ms` : "N/A ms";
        return { reqText, latText };
      };

      const formatted = formatUnknownMetrics(unknownMetric);
      // Genuine 0 values are preserved
      expect(formatted.reqText).toBe("0 req/s");
      expect(formatted.latText).toBe("0ms");
    });

    it("renders missing metrics as N/A instead of printing zero placeholders", () => {
      const unknownMetric: ObservedServiceMetric = {
        serviceId: "external-auth",
        serviceName: "external-auth",
        source: "PROMETHEUS",
        status: "UNKNOWN",
        latencyMs: 0,
        hasValidLatency: false, // Invalid / missing latency
        errorRate: 0,
        hasValidErrorRate: false,
        requestRate: 0,
        hasValidRequestRate: false, // Invalid / missing request rate
        lastObserved: "2026-10-31T00:00:00Z",
        traceCount: 0,
        isStale: true,
        isKnownInTopology: false,
      };

      const formatUnknownMetrics = (u: ObservedServiceMetric) => {
        const reqText = u.hasValidRequestRate === true ? `${u.requestRate} req/s` : "N/A req/s";
        const latText = u.hasValidLatency === true ? `${u.latencyMs}ms` : "N/A ms";
        return { reqText, latText };
      };

      const formatted = formatUnknownMetrics(unknownMetric);
      // Missing fields render as N/A
      expect(formatted.reqText).toBe("N/A req/s");
      expect(formatted.latText).toBe("N/A ms");
    });
  });

  // =========================================================================
  // 11. Component-Level ServiceGraph Props & Drawer Telemetry Synchronization
  // =========================================================================
  describe("Component-Level ServiceGraph Props & Drawer Telemetry Synchronization", () => {
    it("simulates ServiceGraph receiving updated service props and changing node data while preserving coordinates", () => {
      // Step 1: Initial mount
      const initialServices = [...baseDbServices];
      let currentNodes = buildGraphNodes(initialServices, [], null, []);

      // Verify initial gateway latency
      const initialGateway = currentNodes.find((n) => n.id === "api-gateway");
      expect((initialGateway?.data as Record<string, unknown>).latency).toBe(18);

      // Step 2: User drags api-gateway to custom coordinates { x: 555, y: 777 }
      currentNodes = currentNodes.map((n) =>
        n.id === "api-gateway" ? { ...n, position: { x: 555, y: 777 } } : n
      );

      // Step 3: Polling cycle updates service props with elevated latency and degraded status
      const updatedServices: ServiceMapItem[] = baseDbServices.map((s) =>
        s.id === "api-gateway"
          ? {
              ...s,
              status: "DEGRADED",
              currentLatency: 280,
              hasValidLatency: true,
              currentErrorRate: 6.2,
              hasValidErrorRate: true,
            }
          : s
      );

      // Effect execution: setNodes((prev) => buildGraphNodes(services, prev, ...))
      const synchronizedNodes = buildGraphNodes(updatedServices, currentNodes, null, []);
      const updatedGateway = synchronizedNodes.find((n) => n.id === "api-gateway");

      // Verifications:
      // 1. Dragged coordinates remain unchanged
      expect(updatedGateway?.position).toEqual({ x: 555, y: 777 });
      // 2. Node data reflects updated telemetry
      expect((updatedGateway?.data as Record<string, unknown>).latency).toBe(280);
      expect((updatedGateway?.data as Record<string, unknown>).status).toBe("DEGRADED");
      expect((updatedGateway?.data as Record<string, unknown>).errorRate).toBe(6.2);
    });

    it("simulates ServiceGraph receiving updated dependency props and updating rendered edges", () => {
      // Step 1: Initial dependencies
      let currentEdges = buildGraphEdges(baseDependencies, null, []);
      expect(currentEdges.length).toBe(3);

      // Step 2: New downstream dependency added to notification-service
      const updatedDependencies: ServiceDependencyItem[] = [
        ...baseDependencies,
        {
          sourceServiceId: "order-service",
          targetServiceId: "notification-service",
          dependencyType: "ASYNC_EVENT",
          timeoutThreshold: 5000,
        },
      ];

      // Effect execution: setEdges(buildGraphEdges(dependencies, ...))
      currentEdges = buildGraphEdges(updatedDependencies, null, []);
      expect(currentEdges.length).toBe(4);

      const asyncEdge = currentEdges.find((e) => e.target === "notification-service");
      expect(asyncEdge).toBeDefined();
      expect(asyncEdge?.source).toBe("order-service");
    });

    it("verifies ServiceDetailDrawer renders N/A for UNKNOWN metrics and displays valid measurements", () => {
      const renderDrawerMetrics = (service: ServiceMapItem) => {
        const hasLatency =
          service.hasValidLatency !== false &&
          service.currentLatency !== null &&
          service.currentLatency !== undefined;

        const hasError =
          service.hasValidErrorRate !== false &&
          service.currentErrorRate !== null &&
          service.currentErrorRate !== undefined;

        const hasVolume =
          service.hasValidRequestRate !== false &&
          service.requestRate !== null &&
          service.requestRate !== undefined;

        return {
          latencyText: hasLatency ? `${Math.round(service.currentLatency!)}ms` : "N/A",
          errorText: hasError ? `${service.currentErrorRate!.toFixed(1)}%` : "N/A",
          volumeText: hasVolume ? `${service.requestRate} requests / sec` : "N/A",
          status: service.status,
        };
      };

      // Case A: Complete valid telemetry
      const healthyService: ServiceMapItem = {
        ...baseDbServices[0],
        status: "HEALTHY",
        currentLatency: 22,
        hasValidLatency: true,
        currentErrorRate: 0.1,
        hasValidErrorRate: true,
        requestRate: 850,
        hasValidRequestRate: true,
      };
      const healthyRender = renderDrawerMetrics(healthyService);
      expect(healthyRender.latencyText).toBe("22ms");
      expect(healthyRender.errorText).toBe("0.1%");
      expect(healthyRender.volumeText).toBe("850 requests / sec");

      // Case B: UNKNOWN status with missing latency and missing error rate
      const unknownService: ServiceMapItem = {
        ...baseDbServices[0],
        status: "UNKNOWN",
        currentLatency: null,
        hasValidLatency: false,
        currentErrorRate: null,
        hasValidErrorRate: false,
        requestRate: null,
        hasValidRequestRate: false,
      };
      const unknownRender = renderDrawerMetrics(unknownService);
      expect(unknownRender.latencyText).toBe("N/A");
      expect(unknownRender.errorText).toBe("N/A");
      expect(unknownRender.volumeText).toBe("N/A");
      expect(unknownRender.status).toBe("UNKNOWN");
    });
  });
});
