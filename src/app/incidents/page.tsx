"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  Search,
  ArrowRight,
  Flame,
  Zap,
} from "lucide-react";

interface IncidentListItem {
  id: string;
  title: string;
  description: string;
  severity: string;
  status: string;
  startedAt: string;
  _count?: { evidences: number };
  rootCauseCandidates?: {
    score: number;
    candidateServiceId: string;
    service?: { name: string };
  }[];
}

export default function IncidentsPage() {
  const [incidents, setIncidents] = useState<IncidentListItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [loading, setLoading] = useState(true);

  const fetchIncidents = useCallback(async () => {
    try {
      const res = await fetch("/api/incidents");
      if (res.ok) {
        const data = await res.json();
        setIncidents(data.incidents ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (active) await fetchIncidents();
    };
    void poll();
    const interval = setInterval(poll, 4000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [fetchIncidents]);

  const filteredIncidents = incidents.filter((inc) => {
    const matchesSearch =
      inc.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      inc.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      inc.id.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesSeverity = severityFilter === "ALL" || inc.severity === severityFilter;
    const matchesStatus = statusFilter === "ALL" || inc.status === statusFilter;
    return matchesSearch && matchesSeverity && matchesStatus;
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-rose-500/20 px-2.5 py-0.5 text-xs font-semibold text-rose-400 border border-rose-500/30">
              Incident Management
            </span>
            <span className="text-xs text-slate-400 font-mono">Triage & Post-Mortem Records</span>
          </div>
          <h1 className="mt-1.5 text-2xl font-black text-white tracking-tight sm:text-3xl">
            Incidents & Anomalies
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            Audit trail of detected service degradation events, root-cause analyses, and recorded evidence.
          </p>
        </div>

        <Link
          href="/simulator"
          className="flex items-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 px-4 py-2.5 text-xs font-bold text-white shadow-lg shadow-blue-600/30 transition-all"
        >
          <Flame className="h-4 w-4" />
          <span>Inject Failure Scenario</span>
        </Link>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 backdrop-blur-md">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search by title, ID, or description..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-xl border border-slate-800 bg-slate-950/80 pl-9 pr-3 py-2 text-xs text-slate-200 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {/* Severity Filter */}
          <div className="flex items-center rounded-xl border border-slate-800 bg-slate-950/80 p-1 text-xs">
            {["ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW"].map((sev) => (
              <button
                key={sev}
                onClick={() => setSeverityFilter(sev)}
                className={`rounded-lg px-2.5 py-1 font-mono text-[11px] transition-colors ${
                  severityFilter === sev
                    ? "bg-slate-800 text-rose-400 font-bold"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {sev}
              </button>
            ))}
          </div>

          {/* Status Filter */}
          <div className="flex items-center rounded-xl border border-slate-800 bg-slate-950/80 p-1 text-xs">
            {["ALL", "INVESTIGATING", "IDENTIFIED", "RESOLVED"].map((st) => (
              <button
                key={st}
                onClick={() => setStatusFilter(st)}
                className={`rounded-lg px-2.5 py-1 font-mono text-[11px] transition-colors ${
                  statusFilter === st
                    ? "bg-slate-800 text-blue-400 font-bold"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {st}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Incidents Table */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 overflow-hidden shadow-xl backdrop-blur-md">
        {loading ? (
          <div className="py-16 text-center text-xs font-mono text-slate-400">
            Loading incidents...
          </div>
        ) : filteredIncidents.length === 0 ? (
          <div className="py-16 text-center text-xs text-slate-400 italic">
            No matching incidents found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-800 bg-slate-950/60 text-[11px] font-mono uppercase text-slate-400">
                <tr>
                  <th className="py-3.5 px-4 font-semibold">Incident</th>
                  <th className="py-3.5 px-4 font-semibold">Severity</th>
                  <th className="py-3.5 px-4 font-semibold">Status</th>
                  <th className="py-3.5 px-4 font-semibold">Suspected Root Cause</th>
                  <th className="py-3.5 px-4 font-semibold">Evidence Collected</th>
                  <th className="py-3.5 px-4 font-semibold">Started At</th>
                  <th className="py-3.5 px-4 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filteredIncidents.map((inc) => {
                  const topCandidate = inc.rootCauseCandidates?.[0];
                  return (
                    <tr key={inc.id} className="hover:bg-slate-800/40 transition-colors">
                      <td className="py-4 px-4">
                        <div className="font-bold text-slate-100">{inc.title}</div>
                        <span className="font-mono text-[10px] text-slate-400">{inc.id}</span>
                      </td>
                      <td className="py-4 px-4">
                        <span
                          className={`rounded px-2.5 py-0.5 font-mono text-[10px] font-bold ${
                            inc.severity === "CRITICAL"
                              ? "bg-rose-500/20 text-rose-400 border border-rose-500/30"
                              : inc.severity === "HIGH"
                              ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                              : "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                          }`}
                        >
                          {inc.severity}
                        </span>
                      </td>
                      <td className="py-4 px-4">
                        <span
                          className={`rounded px-2 py-0.5 font-mono text-[10px] font-semibold ${
                            inc.status === "RESOLVED"
                              ? "bg-emerald-500/20 text-emerald-400"
                              : "bg-purple-500/20 text-purple-400"
                          }`}
                        >
                          {inc.status}
                        </span>
                      </td>
                      <td className="py-4 px-4 font-medium">
                        {topCandidate ? (
                          <div className="flex items-center gap-1.5 text-purple-300">
                            <Zap className="h-3.5 w-3.5 text-purple-400" />
                            <span>{topCandidate.service?.name ?? topCandidate.candidateServiceId}</span>
                            <span className="text-[10px] font-mono text-purple-400">
                              ({topCandidate.score}/100)
                            </span>
                          </div>
                        ) : (
                          <span className="text-slate-400 font-mono text-[11px]">Analyzing...</span>
                        )}
                      </td>
                      <td className="py-4 px-4 font-mono text-slate-300">
                        {inc._count?.evidences ?? 0} signal(s)
                      </td>
                      <td className="py-4 px-4 font-mono text-slate-400 text-[11px]">
                        {new Date(inc.startedAt).toLocaleTimeString()}
                      </td>
                      <td className="py-4 px-4 text-right">
                        <Link
                          href={`/incidents/${inc.id}`}
                          className="inline-flex items-center gap-1 rounded-lg bg-blue-600/20 border border-blue-500/30 hover:bg-blue-600 hover:text-white px-3 py-1.5 font-semibold text-blue-400 transition-colors"
                        >
                          <span>Investigate</span>
                          <ArrowRight className="h-3 w-3" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
