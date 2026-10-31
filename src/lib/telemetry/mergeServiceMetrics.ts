import { Node, Edge, ConnectionLineType, MarkerType } from "@xyflow/react";
import { ObservedServiceMetric } from "./types";
import { ServiceNodeCustomData } from "@/components/graph/ServiceNode";

export type TelemetryUIMode = "SIMULATION" | "LIVE" | "DEGRADED";

export interface ServiceMapItem {
  id: string;
  name: string;
  serviceType: string;
  tier: number;
  status: "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN";
  currentLatency: number | null;
  baselineLatency: number;
  currentErrorRate: number | null;
  baselineErrorRate: number;
  requestRate: number | null;
  description: string;
  hasValidLatency?: boolean;
  hasValidErrorRate?: boolean;
  hasValidRequestRate?: boolean;
  isObservedLive?: boolean;
  provenance?: "LIVE" | "MOCK_EMULATION" | "LOCAL" | "DISABLED" | "ERROR";
  isStale?: boolean;
  lastObserved?: string;
}

export interface ServiceDependencyItem {
  sourceServiceId: string;
  targetServiceId: string;
  dependencyType: string;
  timeoutThreshold: number;
  criticality?: string;
}

// Canonical tier coordinates for hierarchical topology visualization
export const TIER_POSITIONS: Record<string, { x: number; y: number }> = {
  "api-gateway": { x: 380, y: 40 }, // Tier 1: Ingress Edge
  "auth-service": { x: 120, y: 190 }, // Tier 2: Auth
  "order-service": { x: 380, y: 190 }, // Tier 2: Order Core
  "notification-service": { x: 680, y: 190 }, // Tier 2: Async Notification
  "payment-service": { x: 220, y: 340 }, // Tier 2: Payment
  "inventory-service": { x: 500, y: 340 }, // Tier 2: Inventory
  "postgres-db": { x: 380, y: 490 }, // Tier 3/4: PostgreSQL Data Store
};

/**
 * Normalizes telemetry mode string safely to one of three canonical UI modes:
 * "SIMULATION", "LIVE", or "DEGRADED".
 * Retains "REAL" only as a backward-compatible input alias mapping to "LIVE".
 */
export function normalizeTelemetryMode(mode: string | null | undefined): TelemetryUIMode {
  if (mode === "REAL" || mode === "LIVE") {
    return "LIVE";
  }
  if (mode === "DEGRADED") {
    return "DEGRADED";
  }
  return "SIMULATION";
}

/**
 * Merges raw database service definitions with live observed telemetry.
 *
 * Rules:
 * 1. SIMULATION mode preserves database simulation state with valid flags and DISABLED provenance.
 * 2. LIVE / DEGRADED modes match observations by service ID and propagate explicit provenance.
 * 3. Applies latency ONLY when hasValidLatency === true.
 * 4. Applies error rate ONLY when hasValidErrorRate === true.
 * 5. Applies request rate ONLY when hasValidRequestRate === true.
 * 6. Missing metrics become null (displayed as N/A), NEVER manufactured zeroes or database baselines.
 * 7. If a topology service has no observation in LIVE/DEGRADED mode, its status is UNKNOWN and provenance is ERROR.
 */
export function mergeServiceMetrics(
  dbServices: ServiceMapItem[],
  observedServices: ObservedServiceMetric[] = [],
  mode: TelemetryUIMode
): ServiceMapItem[] {
  if (mode === "SIMULATION") {
    return dbServices.map((svc) => ({
      ...svc,
      provenance: "DISABLED" as const,
      hasValidLatency: true,
      hasValidErrorRate: true,
      hasValidRequestRate: true,
      isObservedLive: false,
      isStale: false,
    }));
  }

  // LIVE or DEGRADED mode
  return dbServices.map((svc) => {
    const observed = observedServices.find(
      (o) => o.serviceId === svc.id || o.serviceName === svc.name
    );

    if (!observed) {
      // In LIVE or DEGRADED mode, an unobserved topology node must report UNKNOWN
      // without claiming database baseline values as live measurements.
      return {
        ...svc,
        status: "UNKNOWN",
        provenance: "ERROR" as const,
        currentLatency: null,
        currentErrorRate: null,
        requestRate: null,
        hasValidLatency: false,
        hasValidErrorRate: false,
        hasValidRequestRate: false,
        isObservedLive: true,
        isStale: true,
        lastObserved: undefined,
      };
    }

    const hasValidLatency = observed.hasValidLatency === true;
    const hasValidErrorRate = observed.hasValidErrorRate === true;
    const hasValidRequestRate = observed.hasValidRequestRate === true;

    return {
      ...svc,
      status: observed.status,
      provenance: observed.provenance ?? (observed.source === "SIMULATION" ? "DISABLED" : "LIVE"),
      // Apply metrics ONLY when explicitly flagged as valid
      currentLatency: hasValidLatency ? observed.latencyMs : null,
      currentErrorRate: hasValidErrorRate ? observed.errorRate : null,
      requestRate: hasValidRequestRate ? observed.requestRate : null,
      hasValidLatency,
      hasValidErrorRate,
      hasValidRequestRate,
      isObservedLive: true,
      isStale: observed.isStale,
      lastObserved: observed.lastObserved,
    };
  });
}

/**
 * Builds React Flow nodes while preserving user-dragged node coordinates.
 * Avoids unnecessary object recreation when node data and positions have not changed.
 */
export function buildGraphNodes(
  services: ServiceMapItem[],
  currentNodes: Node[] = [],
  suspectedRootCauseId?: string | null,
  affectedServiceIds: string[] = []
): Node[] {
  const positionMap = new Map<string, { x: number; y: number }>();
  const existingNodeMap = new Map<string, Node>();

  for (const node of currentNodes) {
    positionMap.set(node.id, node.position);
    existingNodeMap.set(node.id, node);
  }

  let hasAnyChanges = currentNodes.length !== services.length;

  const updatedNodes = services.map((svc) => {
    const savedPos = positionMap.get(svc.id);
    const position = savedPos ?? TIER_POSITIONS[svc.id] ?? {
      x: (svc.tier - 1) * 260 + 100,
      y: svc.tier * 150,
    };

    const isRootCause = svc.id === suspectedRootCauseId;
    const isAffected = affectedServiceIds.includes(svc.id);

    const existing = existingNodeMap.get(svc.id);
    const existingData = existing?.data as unknown as ServiceNodeCustomData | undefined;

    // Check if data changed
    const isDataEqual =
      existingData &&
      existingData.name === svc.name &&
      existingData.serviceType === svc.serviceType &&
      existingData.tier === svc.tier &&
      existingData.status === svc.status &&
      existingData.latency === svc.currentLatency &&
      existingData.baselineLatency === svc.baselineLatency &&
      existingData.errorRate === svc.currentErrorRate &&
      existingData.baselineErrorRate === svc.baselineErrorRate &&
      existingData.requestRate === svc.requestRate &&
      existingData.hasValidLatency === svc.hasValidLatency &&
      existingData.hasValidErrorRate === svc.hasValidErrorRate &&
      existingData.hasValidRequestRate === svc.hasValidRequestRate &&
      existingData.isRootCause === isRootCause &&
      existingData.isAffected === isAffected;

    if (existing && isDataEqual && existing.position.x === position.x && existing.position.y === position.y) {
      return existing;
    }

    hasAnyChanges = true;

    const nodeData: ServiceNodeCustomData = {
      id: svc.id,
      name: svc.name,
      serviceType: svc.serviceType,
      tier: svc.tier,
      status: svc.status,
      latency: svc.currentLatency,
      baselineLatency: svc.baselineLatency,
      errorRate: svc.currentErrorRate,
      baselineErrorRate: svc.baselineErrorRate,
      requestRate: svc.requestRate,
      hasValidLatency: svc.hasValidLatency,
      hasValidErrorRate: svc.hasValidErrorRate,
      hasValidRequestRate: svc.hasValidRequestRate,
      isRootCause,
      isAffected,
    };

    return {
      id: svc.id,
      type: "serviceNode",
      position,
      data: nodeData,
    };
  });

  return hasAnyChanges ? updatedNodes : currentNodes;
}

/**
 * Builds React Flow edges for service dependencies.
 */
export function buildGraphEdges(
  dependencies: ServiceDependencyItem[],
  suspectedRootCauseId?: string | null,
  affectedServiceIds: string[] = []
): Edge[] {
  return dependencies.map((dep) => {
    const isPathAffected =
      dep.targetServiceId === suspectedRootCauseId ||
      affectedServiceIds.includes(dep.sourceServiceId);

    const edgeColor = isPathAffected ? "#f43f5e" : "#64748b";

    return {
      id: `${dep.sourceServiceId}->${dep.targetServiceId}`,
      source: dep.sourceServiceId,
      target: dep.targetServiceId,
      type: ConnectionLineType.SmoothStep,
      animated: isPathAffected,
      style: {
        stroke: edgeColor,
        strokeWidth: isPathAffected ? 2.5 : 1.5,
        strokeDasharray: dep.dependencyType === "ASYNC_QUEUE" ? "4,4" : undefined,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: edgeColor,
        width: 14,
        height: 14,
      },
      label: `${dep.dependencyType} (${dep.timeoutThreshold}ms)`,
      labelStyle: {
        fill: "#94a3b8",
        fontWeight: 500,
        fontSize: 10,
        fontFamily: "monospace",
      },
      labelBgStyle: {
        fill: "#0f172a",
        fillOpacity: 0.9,
        rx: 4,
        ry: 4,
      },
    };
  });
}
