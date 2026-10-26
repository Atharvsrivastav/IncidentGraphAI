-- IncidentGraph AI: Initial PostgreSQL Migration
-- Compatible with Neon, Supabase, AWS RDS PostgreSQL 14+

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE IF NOT EXISTS "Service" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'HEALTHY',
    "baselineLatency" DOUBLE PRECISION NOT NULL,
    "currentLatency" DOUBLE PRECISION NOT NULL,
    "baselineErrorRate" DOUBLE PRECISION NOT NULL,
    "currentErrorRate" DOUBLE PRECISION NOT NULL,
    "requestRate" DOUBLE PRECISION NOT NULL,
    "tier" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ServiceDependency" (
    "id" TEXT NOT NULL,
    "sourceServiceId" TEXT NOT NULL,
    "targetServiceId" TEXT NOT NULL,
    "dependencyType" TEXT NOT NULL DEFAULT 'SYNC_HTTP',
    "timeoutThreshold" DOUBLE PRECISION NOT NULL DEFAULT 2000.0,
    "criticality" TEXT NOT NULL DEFAULT 'HIGH',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceDependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Incident" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'HIGH',
    "status" TEXT NOT NULL DEFAULT 'INVESTIGATING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "simulationScenario" TEXT,
    "rootCauseStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "suspectedRootCauseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TelemetrySample" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "simulationStep" INTEGER NOT NULL DEFAULT 0,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latency" DOUBLE PRECISION NOT NULL,
    "errorRate" DOUBLE PRECISION NOT NULL,
    "requestCount" DOUBLE PRECISION NOT NULL,
    "healthStatus" TEXT NOT NULL DEFAULT 'HEALTHY',
    "cpuUsage" DOUBLE PRECISION,
    "memoryUsage" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelemetrySample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "IncidentEvidence" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "evidenceType" TEXT NOT NULL,
    "observedValue" DOUBLE PRECISION NOT NULL,
    "expectedValue" DOUBLE PRECISION NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'ms',
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "explanation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "RootCauseCandidate" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "candidateServiceId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "rank" INTEGER NOT NULL,
    "confidence" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "supportingEvidence" TEXT NOT NULL,
    "contradictoryEvidence" TEXT NOT NULL,
    "recommendedAction" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RootCauseCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SimulationState" (
    "id" TEXT NOT NULL DEFAULT 'active_simulation',
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "activeScenario" TEXT,
    "injectedServiceId" TEXT,
    "failureType" TEXT,
    "severity" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SimulationState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AiInvestigation" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "verifiedImpact" TEXT NOT NULL,
    "diagnosisStatus" TEXT NOT NULL,
    "confidenceCategory" TEXT NOT NULL,
    "confidenceExplanation" TEXT NOT NULL,
    "rankedHypothesesJson" TEXT NOT NULL,
    "recommendedChecksJson" TEXT NOT NULL,
    "remediationOptionsJson" TEXT NOT NULL,
    "missingEvidenceJson" TEXT NOT NULL,
    "nextObservationsJson" TEXT NOT NULL,
    "provenance" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "executionTimeMs" INTEGER NOT NULL,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "totalTokens" INTEGER,
    "rawResponseJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiInvestigation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ServiceDependency_sourceServiceId_idx" ON "ServiceDependency"("sourceServiceId");
CREATE INDEX IF NOT EXISTS "ServiceDependency_targetServiceId_idx" ON "ServiceDependency"("targetServiceId");
CREATE UNIQUE INDEX IF NOT EXISTS "ServiceDependency_sourceServiceId_targetServiceId_key" ON "ServiceDependency"("sourceServiceId", "targetServiceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Incident_status_idx" ON "Incident"("status");
CREATE INDEX IF NOT EXISTS "Incident_severity_idx" ON "Incident"("severity");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TelemetrySample_serviceId_simulationStep_idx" ON "TelemetrySample"("serviceId", "simulationStep");
CREATE INDEX IF NOT EXISTS "TelemetrySample_timestamp_idx" ON "TelemetrySample"("timestamp");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "IncidentEvidence_incidentId_idx" ON "IncidentEvidence"("incidentId");
CREATE INDEX IF NOT EXISTS "IncidentEvidence_serviceId_idx" ON "IncidentEvidence"("serviceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RootCauseCandidate_incidentId_idx" ON "RootCauseCandidate"("incidentId");
CREATE INDEX IF NOT EXISTS "RootCauseCandidate_candidateServiceId_idx" ON "RootCauseCandidate"("candidateServiceId");
CREATE UNIQUE INDEX IF NOT EXISTS "RootCauseCandidate_incidentId_rank_key" ON "RootCauseCandidate"("incidentId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AiInvestigation_incidentId_key" ON "AiInvestigation"("incidentId");
CREATE INDEX IF NOT EXISTS "AiInvestigation_incidentId_idx" ON "AiInvestigation"("incidentId");
CREATE INDEX IF NOT EXISTS "AiInvestigation_diagnosisStatus_idx" ON "AiInvestigation"("diagnosisStatus");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ServiceDependency" ADD CONSTRAINT "ServiceDependency_sourceServiceId_fkey" FOREIGN KEY ("sourceServiceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "ServiceDependency" ADD CONSTRAINT "ServiceDependency_targetServiceId_fkey" FOREIGN KEY ("targetServiceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "TelemetrySample" ADD CONSTRAINT "TelemetrySample_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "IncidentEvidence" ADD CONSTRAINT "IncidentEvidence_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "IncidentEvidence" ADD CONSTRAINT "IncidentEvidence_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "RootCauseCandidate" ADD CONSTRAINT "RootCauseCandidate_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "RootCauseCandidate" ADD CONSTRAINT "RootCauseCandidate_candidateServiceId_fkey" FOREIGN KEY ("candidateServiceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "AiInvestigation" ADD CONSTRAINT "AiInvestigation_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
