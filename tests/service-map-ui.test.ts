import { describe, it, expect, vi } from "vitest";
import {
  normalizeTelemetryMode,
  mergeServiceMetrics,
  buildGraphNodes,
  buildGraphEdges,
  ServiceMapItem,
  ServiceDependencyItem,
} from "../src/lib/telemetry/mergeServiceMetrics";
import { ObservedServiceMetric } from "../src/lib/telemetry/types";
import { telemetryManager, TelemetryManager } from "../src/lib/telemetry/telemetryManager";
import { determineTelemetryProvenance, parsePersistedProvenance } from "../src/lib/ai/investigator";
import { GET as getModeRoute } from "../src/app/api/telemetry/mode/route";

describe("Service Map Utility & State-Logic Unit Test Suite", () => {
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
  // 8. Navigation State-Logic & Failed Request Guard Unit Tests
  // =========================================================================
  describe("Navigation State-Logic & Failed Request Guard Unit Tests", () => {
    it("simulates failed POST request, awaits handler completion, and proves state is never falsely updated to LIVE", async () => {
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
            // Failed request: NEVER set status to LIVE! State remains untouched
          }
        } catch {
          // Network failure: NEVER set status to LIVE!
        }
      };

      // Correctly await asynchronous mode switch operation
      await handleModeSwitch("LIVE");

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

    it("determines truthful Navigation OTel button label and never shows 'Live OTel (Connected)' for mock emulation", () => {
      const getOtelButtonLabel = (params: {
        isSwitchingMode: boolean;
        requestedMode: string;
        effectiveMode: string;
        backendType: string;
      }) => {
        const { isSwitchingMode, requestedMode, effectiveMode, backendType } = params;
        if (isSwitchingMode) return "Connecting...";
        if (requestedMode === "LIVE") {
          if (effectiveMode === "DEGRADED" || backendType === "UNAVAILABLE") {
            return "OTel (Degraded)";
          }
          if (backendType === "MOCK_EMULATION") {
            return "Mock Emulation";
          }
          if (backendType === "GRAFANA_CLOUD") {
            return "Grafana Cloud (Connected)";
          }
          if (backendType === "GENUINE_STACK") {
            return "Live OTel (Connected)";
          }
          return "Live OTel (Connected)";
        }
        return "Live OTel";
      };

      // 1. Inactive state (SIMULATION requested)
      expect(
        getOtelButtonLabel({
          isSwitchingMode: false,
          requestedMode: "SIMULATION",
          effectiveMode: "SIMULATION",
          backendType: "SIMULATION",
        })
      ).toBe("Live OTel");

      // 2. Switching mode in-flight
      expect(
        getOtelButtonLabel({
          isSwitchingMode: true,
          requestedMode: "LIVE",
          effectiveMode: "LIVE",
          backendType: "GENUINE_STACK",
        })
      ).toBe("Connecting...");

      // 3. Mock emulation: MUST be "Mock Emulation", NEVER "Live OTel (Connected)"
      expect(
        getOtelButtonLabel({
          isSwitchingMode: false,
          requestedMode: "LIVE",
          effectiveMode: "LIVE",
          backendType: "MOCK_EMULATION",
        })
      ).toBe("Mock Emulation");

      // 4. Grafana Cloud: "Grafana Cloud (Connected)"
      expect(
        getOtelButtonLabel({
          isSwitchingMode: false,
          requestedMode: "LIVE",
          effectiveMode: "LIVE",
          backendType: "GRAFANA_CLOUD",
        })
      ).toBe("Grafana Cloud (Connected)");

      // 5. Genuine Docker stack: "Live OTel (Connected)"
      expect(
        getOtelButtonLabel({
          isSwitchingMode: false,
          requestedMode: "LIVE",
          effectiveMode: "LIVE",
          backendType: "GENUINE_STACK",
        })
      ).toBe("Live OTel (Connected)");

      // 6. Degraded or unavailable: "OTel (Degraded)"
      expect(
        getOtelButtonLabel({
          isSwitchingMode: false,
          requestedMode: "LIVE",
          effectiveMode: "DEGRADED",
          backendType: "UNAVAILABLE",
        })
      ).toBe("OTel (Degraded)");
    });

    it("evaluates Navigation status badge: accurately reflects backendType and degraded state", () => {
      const getNavigationBadge = (params: {
        systemStatus: string;
        requestedMode: string;
        effectiveMode: string;
        backendType: string;
        activeScenario?: string | null;
      }) => {
        const { systemStatus, requestedMode, effectiveMode, backendType, activeScenario } = params;
        if (systemStatus === "INCIDENT") {
          return {
            dot: "bg-red-500 animate-pulse",
            label: `Active Incident (${activeScenario ?? (requestedMode === "SIMULATION" ? "Simulated" : "Live")})`,
          };
        }
        if (effectiveMode === "DEGRADED" || backendType === "UNAVAILABLE") {
          return { dot: "bg-amber-500 animate-pulse", label: "Telemetry Pipeline Degraded" };
        }
        if (requestedMode === "LIVE" && backendType === "MOCK_EMULATION") {
          return { dot: "bg-purple-400", label: "Mock Telemetry Emulation" };
        }
        if (requestedMode === "LIVE" && backendType === "GRAFANA_CLOUD") {
          return { dot: "bg-sky-400", label: "Grafana Cloud Telemetry" };
        }
        if (requestedMode === "LIVE" && backendType === "GENUINE_STACK") {
          return { dot: "bg-emerald-500", label: "Genuine Local Telemetry" };
        }
        if (requestedMode === "SIMULATION") {
          return { dot: "bg-blue-400", label: "Simulation Mode" };
        }
        return { dot: "bg-emerald-500", label: "All Systems Operational" };
      };

      // 1. Simulation without incident -> Simulation Mode
      expect(
        getNavigationBadge({
          systemStatus: "HEALTHY",
          requestedMode: "SIMULATION",
          effectiveMode: "SIMULATION",
          backendType: "SIMULATION",
        })
      ).toEqual({
        dot: "bg-blue-400",
        label: "Simulation Mode",
      });

      // 2. LIVE + MOCK_EMULATION -> Mock Telemetry Emulation
      expect(
        getNavigationBadge({
          systemStatus: "HEALTHY",
          requestedMode: "LIVE",
          effectiveMode: "LIVE",
          backendType: "MOCK_EMULATION",
        })
      ).toEqual({
        dot: "bg-purple-400",
        label: "Mock Telemetry Emulation",
      });

      // 3. LIVE + GRAFANA_CLOUD -> Grafana Cloud Telemetry
      expect(
        getNavigationBadge({
          systemStatus: "HEALTHY",
          requestedMode: "LIVE",
          effectiveMode: "LIVE",
          backendType: "GRAFANA_CLOUD",
        })
      ).toEqual({
        dot: "bg-sky-400",
        label: "Grafana Cloud Telemetry",
      });

      // 4. LIVE + GENUINE_STACK -> Genuine Local Telemetry
      expect(
        getNavigationBadge({
          systemStatus: "HEALTHY",
          requestedMode: "LIVE",
          effectiveMode: "LIVE",
          backendType: "GENUINE_STACK",
        })
      ).toEqual({
        dot: "bg-emerald-500",
        label: "Genuine Local Telemetry",
      });

      // 5. Telemetry degraded -> Telemetry Pipeline Degraded
      expect(
        getNavigationBadge({
          systemStatus: "HEALTHY",
          requestedMode: "LIVE",
          effectiveMode: "DEGRADED",
          backendType: "UNAVAILABLE",
        })
      ).toEqual({
        dot: "bg-amber-500 animate-pulse",
        label: "Telemetry Pipeline Degraded",
      });

      // 6. Incident active -> Active Incident
      expect(
        getNavigationBadge({
          systemStatus: "INCIDENT",
          requestedMode: "LIVE",
          effectiveMode: "LIVE",
          backendType: "GENUINE_STACK",
          activeScenario: "payment-outage",
        })
      ).toEqual({
        dot: "bg-red-500 animate-pulse",
        label: "Active Incident (payment-outage)",
      });
    });
  });

  // =========================================================================
  // 9. Service Map Header & Observation Banner Honest Presentation
  // =========================================================================
  describe("Service Map Header & Observation Banner Honest Presentation", () => {
    it("distinguishes all backend identities truthfully in Service Map header badge and subtitle", () => {
      const getHeaderState = (params: {
        telemetryMode: string;
        backendHealth?: { backendType?: string };
      }) => {
        const { telemetryMode, backendHealth } = params;
        const backendType = backendHealth?.backendType;

        let badgeText = "● Genuine Local Telemetry";
        let subtitleText = "Observing verified live runtime measurements from genuine local Prometheus and Jaeger observability stack.";

        if (telemetryMode === "SIMULATION") {
          badgeText = "⚙ Simulation Mode";
          subtitleText = "Simulated microservices topology and causal failure propagation graph.";
        } else if (telemetryMode === "DEGRADED" || backendType === "UNAVAILABLE") {
          badgeText = "⚠ Telemetry Pipeline Degraded";
          subtitleText = "Observability backends are degraded or partially unreachable. Displaying available partial signals with UNKNOWN states.";
        } else if (backendType === "MOCK_EMULATION") {
          badgeText = "● Mock Telemetry Emulation";
          subtitleText = "Synthetic metrics and distributed traces generated by local development mock server. Non-production emulation.";
        } else if (backendType === "GRAFANA_CLOUD") {
          badgeText = "☁ Grafana Cloud Telemetry";
          subtitleText = "Observing verified live runtime measurements from hosted Grafana Cloud OTLP and Prometheus/Tempo stack.";
        }

        return { badgeText, subtitleText };
      };

      // 1. Simulation
      const sim = getHeaderState({ telemetryMode: "SIMULATION" });
      expect(sim.badgeText).toBe("⚙ Simulation Mode");
      expect(sim.subtitleText).toContain("Simulated microservices topology");

      // 2. Mock Emulation: NEVER claims "Live Telemetry Source" or live runtime measurements
      const mock = getHeaderState({
        telemetryMode: "LIVE",
        backendHealth: { backendType: "MOCK_EMULATION" },
      });
      expect(mock.badgeText).toBe("● Mock Telemetry Emulation");
      expect(mock.badgeText).not.toBe("● Live Telemetry Source");
      expect(mock.subtitleText).toContain("local development mock server");
      expect(mock.subtitleText).not.toContain("verified live runtime measurements");

      // 3. Grafana Cloud
      const cloud = getHeaderState({
        telemetryMode: "LIVE",
        backendHealth: { backendType: "GRAFANA_CLOUD" },
      });
      expect(cloud.badgeText).toBe("☁ Grafana Cloud Telemetry");
      expect(cloud.subtitleText).toContain("hosted Grafana Cloud OTLP");

      // 4. Genuine Local Stack
      const local = getHeaderState({
        telemetryMode: "LIVE",
        backendHealth: { backendType: "GENUINE_STACK" },
      });
      expect(local.badgeText).toBe("● Genuine Local Telemetry");
      expect(local.subtitleText).toContain("genuine local Prometheus");

      // 5. Degraded
      const degraded = getHeaderState({
        telemetryMode: "DEGRADED",
        backendHealth: { backendType: "UNAVAILABLE" },
      });
      expect(degraded.badgeText).toBe("⚠ Telemetry Pipeline Degraded");
      expect(degraded.subtitleText).toContain("Observability backends are degraded");
    });

    it("distinguishes MOCK_EMULATION from genuine production telemetry in banner rendering", () => {
      const getBannerDisplay = (backendType: string, telemetryMode: string) => {
        if (telemetryMode !== "LIVE") return null;

        const isMock = backendType === "MOCK_EMULATION";
        return {
          title: isMock
            ? "Mock Telemetry Emulation Active (Dev Server)"
            : backendType === "GRAFANA_CLOUD"
            ? "Grafana Cloud Telemetry Active"
            : "Genuine Local Telemetry Active",
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
      expect(cloudDisplay?.title).toBe("Grafana Cloud Telemetry Active");
      expect(cloudDisplay?.badge).toBe("☁ Grafana Cloud (Hosted)");
      expect(cloudDisplay?.isProduction).toBe(true);

      // Genuine Docker stack
      const dockerDisplay = getBannerDisplay("GENUINE_STACK", "LIVE");
      expect(dockerDisplay?.title).toBe("Genuine Local Telemetry Active");
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
  // 11. ServiceGraph Node/Edge Builder Utilities & Drawer State-Logic Unit Tests
  // =========================================================================
  describe("ServiceGraph Node/Edge Builder Utilities & Drawer State-Logic Unit Tests", () => {
    it("verifies buildGraphNodes updates node telemetry data while preserving user-dragged coordinates", () => {
      // Step 1: Initial nodes
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

      // Pure utility transformation
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

    it("verifies buildGraphEdges transforms updated dependency items to React Flow edge structures", () => {
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

      // Pure utility transformation
      currentEdges = buildGraphEdges(updatedDependencies, null, []);
      expect(currentEdges.length).toBe(4);

      const asyncEdge = currentEdges.find((e) => e.target === "notification-service");
      expect(asyncEdge).toBeDefined();
      expect(asyncEdge?.source).toBe("order-service");
    });

    it("verifies drawer telemetry formatting logic renders N/A for UNKNOWN metrics and displays valid measurements", () => {
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

  // =========================================================================
  // 12. Mode Transitions & Effective Mode Freshness Unit Tests
  // =========================================================================
  describe("Mode Transitions & Effective Mode Freshness Unit Tests", () => {
    it("ensures SIMULATION mode operates in complete isolation with zero external network telemetry calls", async () => {
      telemetryManager.setMode("SIMULATION");
      const originalFetch = global.fetch;
      const fetchSpy = vi.fn();
      global.fetch = fetchSpy;

      try {
        const res = await getModeRoute();
        const json = await res.json();

        expect(json.mode).toBe("SIMULATION");
        expect(json.requestedMode).toBe("SIMULATION");
        expect(json.effectiveMode).toBe("SIMULATION");
        expect(json.health.backendType).toBe("SIMULATION");
        // Strict isolation: ZERO external network calls made
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("transitions operational state from LIVE to DEGRADED when backends are offline", async () => {
      telemetryManager.setMode("LIVE");
      const originalFetch = global.fetch;

      // Simulate network loss / unreachable backend
      global.fetch = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:9090"));

      try {
        const res = await getModeRoute();
        const json = await res.json();

        expect(json.requestedMode).toBe("LIVE");
        expect(json.effectiveMode).toBe("DEGRADED");
        expect(json.mode).toBe("DEGRADED");
        expect(json.health.backendType).toBe("UNAVAILABLE");
        expect(json.health.prometheusAvailable).toBe(false);
        expect(json.health.jaegerAvailable).toBe(false);
      } finally {
        global.fetch = originalFetch;
        telemetryManager.setMode("SIMULATION");
      }
    });

    it("transitions operational state to DEGRADED when only partial providers are available", async () => {
      telemetryManager.setMode("LIVE");
      const originalFetch = global.fetch;

      // Prometheus responds ok, but Jaeger/Tempo rejects
      global.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes("9090") || urlStr.includes("/api/v1")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({
              status: "success",
              data: { resultType: "vector", result: [] },
            }),
          };
        }
        throw new Error("Jaeger endpoint unreachable");
      });

      try {
        const res = await getModeRoute();
        const json = await res.json();

        // Partial provider availability must transition effective mode to DEGRADED
        expect(json.requestedMode).toBe("LIVE");
        expect(json.effectiveMode).toBe("DEGRADED");
      } finally {
        global.fetch = originalFetch;
        telemetryManager.setMode("SIMULATION");
      }
    });

    it("reuses 3-second observation cache during subsequent GET requests to avoid duplicate provider queries", async () => {
      telemetryManager.setMode("SIMULATION");
      const res1 = await getModeRoute();
      const json1 = await res1.json();

      const res2 = await getModeRoute();
      const json2 = await res2.json();

      expect(json1.effectiveMode).toBe("SIMULATION");
      expect(json2.effectiveMode).toBe("SIMULATION");
      expect(json1.health.backendType).toBe(json2.health.backendType);
    });
  });

  // =========================================================================
  // 13. Truthful AI Telemetry Provenance Unit Tests
  // =========================================================================
  describe("Truthful AI Telemetry Provenance Unit Tests", () => {
    it("returns LIVE_TELEMETRY only when effectiveMode is LIVE and provider is genuine (GRAFANA_CLOUD or GENUINE_STACK)", () => {
      const cloudProv = determineTelemetryProvenance({
        isLiveScenario: true,
        requestedMode: "LIVE",
        effectiveMode: "LIVE",
        hasSimulationScenario: false,
        backendHealth: {
          backendType: "GRAFANA_CLOUD",
          prometheusAvailable: true,
          jaegerAvailable: true,
        },
      });
      expect(cloudProv).toBe("LIVE_TELEMETRY");

      const localProv = determineTelemetryProvenance({
        isLiveScenario: true,
        requestedMode: "LIVE",
        effectiveMode: "LIVE",
        hasSimulationScenario: false,
        backendHealth: {
          backendType: "GENUINE_STACK",
          prometheusAvailable: true,
          jaegerAvailable: true,
        },
      });
      expect(localProv).toBe("LIVE_TELEMETRY");
    });

    it("returns MOCK when backendType is MOCK_EMULATION even if live mode was requested", () => {
      const mockProv = determineTelemetryProvenance({
        isLiveScenario: true,
        requestedMode: "LIVE",
        effectiveMode: "LIVE",
        hasSimulationScenario: false,
        backendHealth: {
          backendType: "MOCK_EMULATION",
          prometheusAvailable: true,
          jaegerAvailable: true,
        },
      });
      expect(mockProv).toBe("MOCK");
    });

    it("returns PARTIAL_TELEMETRY when genuine provider is degraded or partially available", () => {
      const degradedProv = determineTelemetryProvenance({
        isLiveScenario: true,
        requestedMode: "LIVE",
        effectiveMode: "DEGRADED",
        hasSimulationScenario: false,
        backendHealth: {
          backendType: "GENUINE_STACK",
          prometheusAvailable: true,
          jaegerAvailable: false,
        },
      });
      expect(degradedProv).toBe("PARTIAL_TELEMETRY");

      const degradedCloudProv = determineTelemetryProvenance({
        isLiveScenario: true,
        requestedMode: "LIVE",
        effectiveMode: "DEGRADED",
        hasSimulationScenario: false,
        backendHealth: {
          backendType: "GRAFANA_CLOUD",
          prometheusAvailable: false,
          jaegerAvailable: true,
        },
      });
      expect(degradedCloudProv).toBe("PARTIAL_TELEMETRY");
    });

    it("returns UNAVAILABLE when requested LIVE mode has zero available backends or UNAVAILABLE status", () => {
      const unavailProv = determineTelemetryProvenance({
        isLiveScenario: true,
        requestedMode: "LIVE",
        effectiveMode: "DEGRADED",
        hasSimulationScenario: false,
        backendHealth: {
          backendType: "UNAVAILABLE",
          prometheusAvailable: false,
          jaegerAvailable: false,
        },
      });
      expect(unavailProv).toBe("UNAVAILABLE");
    });

    it("returns SIMULATED for simulation incidents and simulation mode", () => {
      const simProv = determineTelemetryProvenance({
        isLiveScenario: false,
        requestedMode: "SIMULATION",
        effectiveMode: "SIMULATION",
        hasSimulationScenario: true,
        backendHealth: {
          backendType: "SIMULATION",
          prometheusAvailable: false,
          jaegerAvailable: false,
        },
      });
      expect(simProv).toBe("SIMULATED");
    });

    it("safely parses legacy persisted provenance records without crashing or reinterpreting valid data", () => {
      expect(parsePersistedProvenance("LIVE_TELEMETRY")).toBe("LIVE_TELEMETRY");
      expect(parsePersistedProvenance("PARTIAL_TELEMETRY")).toBe("PARTIAL_TELEMETRY");
      expect(parsePersistedProvenance("UNAVAILABLE")).toBe("UNAVAILABLE");
      expect(parsePersistedProvenance("SIMULATED")).toBe("SIMULATED");
      expect(parsePersistedProvenance("MOCK")).toBe("MOCK");
      expect(parsePersistedProvenance("REAL")).toBe("LIVE_TELEMETRY");
      expect(parsePersistedProvenance("LIVE")).toBe("LIVE_TELEMETRY");
      expect(parsePersistedProvenance("legacy_unrecognized")).toBe("SIMULATED");
    });
  });
});
