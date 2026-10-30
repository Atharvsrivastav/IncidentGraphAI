"use client";

import React, { useMemo, useState, useCallback, useEffect } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  MiniMap,
  Node,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import { ServiceNode, ServiceNodeCustomData } from "./ServiceNode";
import { ServiceDetailDrawer } from "./ServiceDetailDrawer";
import {
  ServiceMapItem,
  ServiceDependencyItem,
  buildGraphNodes,
  buildGraphEdges,
} from "@/lib/telemetry/mergeServiceMetrics";

interface ServiceGraphProps {
  services: ServiceMapItem[];
  dependencies: ServiceDependencyItem[];
  suspectedRootCauseId?: string | null;
  affectedServiceIds?: string[];
  onServiceRestored?: (serviceId: string) => void;
}

const nodeTypes = {
  serviceNode: ServiceNode,
};

const DEFAULT_AFFECTED_IDS: string[] = [];

export function ServiceGraph({
  services,
  dependencies,
  suspectedRootCauseId,
  affectedServiceIds = DEFAULT_AFFECTED_IDS,
  onServiceRestored,
}: ServiceGraphProps) {
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);

  // Compute initial nodes and edges
  const initialNodes = useMemo(() => {
    return buildGraphNodes(services, [], suspectedRootCauseId, affectedServiceIds);
  }, [services, suspectedRootCauseId, affectedServiceIds]);

  const initialEdges = useMemo(() => {
    return buildGraphEdges(dependencies, suspectedRootCauseId, affectedServiceIds);
  }, [dependencies, suspectedRootCauseId, affectedServiceIds]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Synchronize React Flow nodes when polled services data or highlighting changes,
  // while strictly preserving user-dragged positions
  useEffect(() => {
    setNodes((prevNodes) => {
      return buildGraphNodes(services, prevNodes, suspectedRootCauseId, affectedServiceIds);
    });
  }, [services, suspectedRootCauseId, affectedServiceIds, setNodes]);

  // Synchronize React Flow edges when dependencies or incident paths change
  useEffect(() => {
    setEdges(buildGraphEdges(dependencies, suspectedRootCauseId, affectedServiceIds));
  }, [dependencies, suspectedRootCauseId, affectedServiceIds, setEdges]);

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
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-slate-500" />
          <span className="text-slate-300">Unknown</span>
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
            if (data.status === "UNKNOWN") return "#64748b";
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
