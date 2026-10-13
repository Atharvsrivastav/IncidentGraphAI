"use client";

import React, { useMemo, useState, useCallback } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  MiniMap,
  Node,
  Edge,
  MarkerType,
  useNodesState,
  useEdgesState,
  ConnectionLineType,
} from "@xyflow/react";
import { ServiceNode, ServiceNodeCustomData } from "./ServiceNode";
import { ServiceDetailDrawer } from "./ServiceDetailDrawer";

interface ServiceGraphProps {
  services: {
    id: string;
    name: string;
    serviceType: string;
    tier: number;
    status: "HEALTHY" | "DEGRADED" | "DOWN";
    currentLatency: number;
    baselineLatency: number;
    currentErrorRate: number;
    baselineErrorRate: number;
    requestRate: number;
    description: string;
  }[];
  dependencies: {
    sourceServiceId: string;
    targetServiceId: string;
    dependencyType: string;
    timeoutThreshold: number;
    criticality: string;
  }[];
  suspectedRootCauseId?: string | null;
  affectedServiceIds?: string[];
  onServiceRestored?: (serviceId: string) => void;
}

const nodeTypes = {
  serviceNode: ServiceNode,
};

// Hierarchical layout positions based on architectural tiers
const TIER_POSITIONS: Record<string, { x: number; y: number }> = {
  "api-gateway": { x: 380, y: 40 }, // Tier 1: Ingress Edge
  "auth-service": { x: 120, y: 190 }, // Tier 2: Auth
  "order-service": { x: 380, y: 190 }, // Tier 2: Order Core
  "notification-service": { x: 680, y: 190 }, // Tier 2: Async Notification
  "payment-service": { x: 220, y: 340 }, // Tier 2: Payment
  "inventory-service": { x: 500, y: 340 }, // Tier 2: Inventory
  "postgres-db": { x: 380, y: 490 }, // Tier 3: PostgreSQL Data Store
};

export function ServiceGraph({
  services,
  dependencies,
  suspectedRootCauseId,
  affectedServiceIds = [],
  onServiceRestored,
}: ServiceGraphProps) {
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);

  // Map services to React Flow Nodes
  const initialNodes: Node[] = useMemo(() => {
    return services.map((svc) => {
      const position = TIER_POSITIONS[svc.id] ?? {
        x: (svc.tier - 1) * 260 + 100,
        y: svc.tier * 150,
      };

      const isRootCause = svc.id === suspectedRootCauseId;
      const isAffected = affectedServiceIds.includes(svc.id);

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
  }, [services, suspectedRootCauseId, affectedServiceIds]);

  // Map dependencies to React Flow Edges
  // Convention: source depends on target (A -> B means A calls B)
  const initialEdges: Edge[] = useMemo(() => {
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
  }, [dependencies, suspectedRootCauseId, affectedServiceIds]);

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedServiceId(node.id);
  }, []);

  const selectedService = services.find((s) => s.id === selectedServiceId) ?? null;

  return (
    <div className="relative h-[620px] w-full rounded-2xl border border-slate-800 bg-slate-950/90 shadow-2xl overflow-hidden">
      {/* Legend & Instructions */}
      <div className="absolute top-4 left-4 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/95 px-4 py-2 text-xs backdrop-blur-md">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
          <span className="text-slate-300">Healthy</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
          <span className="text-slate-300">Degraded</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-500" />
          <span className="text-slate-300">Down</span>
        </div>
        <div className="h-3 w-px bg-slate-700" />
        <span className="text-[11px] text-slate-400 font-mono">
          Convention: A → B means A calls / depends on B
        </span>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#1e293b" gap={20} size={1} />
        <Controls className="!m-4" />
        <MiniMap
          nodeColor={(n) => {
            const data = n.data as unknown as ServiceNodeCustomData;
            if (data.status === "DOWN") return "#ef4444";
            if (data.status === "DEGRADED") return "#f59e0b";
            return "#10b981";
          }}
          className="!m-4 !hidden md:!block"
        />
      </ReactFlow>

      {/* Selected Service Detail Drawer */}
      {selectedService && (
        <ServiceDetailDrawer
          service={selectedService}
          dependencies={dependencies}
          allServices={services}
          onClose={() => setSelectedServiceId(null)}
          onRestore={() => {
            onServiceRestored?.(selectedService.id);
            setSelectedServiceId(null);
          }}
        />
      )}
    </div>
  );
}
