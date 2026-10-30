import { SlidingWindowStats, TelemetryPoint } from "./types";

/**
 * Sliding Window Analysis for Telemetry Samples
 *
 * Evaluates metrics over a bounded moving window of samples (e.g. last W steps).
 * Correctly guards against empty samples, insufficient data, and zero denominators.
 */
export class SlidingWindowAnalyzer {
  private readonly windowSize: number;

  constructor(windowSize: number = 5) {
    this.windowSize = Math.max(1, windowSize);
  }

  /**
   * Computes sliding window metrics for a specific service given its time-series telemetry.
   *
   * Complexity: O(W), where W is the number of samples in the window.
   */
  public analyzeServiceWindow(
    serviceId: string,
    samples: TelemetryPoint[],
    baselineLatency: number,
    baselineErrorRate: number
  ): SlidingWindowStats {
    if (!samples || samples.length === 0) {
      return {
        serviceId,
        sampleCount: 0,
        validLatencyCount: 0,
        validErrorRateCount: 0,
        averageLatency: baselineLatency,
        baselineLatency,
        latencyRatio: 1.0,
        averageErrorRate: baselineErrorRate,
        baselineErrorRate,
        errorRateDelta: 0.0,
        firstAnomalousStep: null,
        hasLatencyAnomaly: false,
        hasErrorAnomaly: false,
        hasValidLatency: false,
        hasValidErrorRate: false,
      };
    }

    // Sort samples ascending by simulation step/timestamp
    const sortedSamples = [...samples].sort((a, b) => a.simulationStep - b.simulationStep);
    // Take the most recent W samples
    const windowSlice = sortedSamples.slice(-this.windowSize);
    const count = windowSlice.length;

    let firstAnomalousStep: number | null = null;
    const LATENCY_ANOMALY_THRESHOLD_RATIO = 2.0; // 2x baseline
    const ERROR_ANOMALY_DELTA_THRESHOLD = 5.0; // 5% absolute error increase

    // Temporal anomaly detection: independently evaluate metrics that actually exist
    // Missing evidence must neither create an anomaly nor suppress the other metric's anomaly
    for (const sample of sortedSamples) {
      const hasLat = sample.hasValidLatency !== false && sample.latency !== undefined && !isNaN(sample.latency);
      const hasErr = sample.hasValidErrorRate !== false && sample.errorRate !== undefined && !isNaN(sample.errorRate);

      const isLatencyAnomalous = hasLat && (
        baselineLatency > 0
          ? sample.latency! >= baselineLatency * LATENCY_ANOMALY_THRESHOLD_RATIO
          : sample.latency! > 50
      );

      const isErrorAnomalous = hasErr && (
        sample.errorRate! - baselineErrorRate >= ERROR_ANOMALY_DELTA_THRESHOLD
      );

      if ((isLatencyAnomalous || isErrorAnomalous) && firstAnomalousStep === null) {
        firstAnomalousStep = sample.simulationStep;
      }
    }

    // Sliding-window averages must use ONLY valid metric observations
    // Missing samples must not dilute the other metric's average
    let latencySum = 0;
    let validLatencyCount = 0;
    let errorRateSum = 0;
    let validErrorRateCount = 0;

    for (const sample of windowSlice) {
      if (sample.hasValidLatency !== false && sample.latency !== undefined && !isNaN(sample.latency)) {
        latencySum += sample.latency;
        validLatencyCount++;
      }
      if (sample.hasValidErrorRate !== false && sample.errorRate !== undefined && !isNaN(sample.errorRate)) {
        errorRateSum += sample.errorRate;
        validErrorRateCount++;
      }
    }

    const averageLatency = validLatencyCount > 0 ? latencySum / validLatencyCount : baselineLatency;
    const averageErrorRate = validErrorRateCount > 0 ? errorRateSum / validErrorRateCount : baselineErrorRate;

    const safeBaselineLatency = baselineLatency > 0 ? baselineLatency : 1.0;
    const latencyRatio = validLatencyCount > 0 ? averageLatency / safeBaselineLatency : 1.0;
    const errorRateDelta = validErrorRateCount > 0 ? Math.max(0, averageErrorRate - baselineErrorRate) : 0.0;

    const hasLatencyAnomaly = validLatencyCount > 0 && latencyRatio >= LATENCY_ANOMALY_THRESHOLD_RATIO;
    const hasErrorAnomaly = validErrorRateCount > 0 && errorRateDelta >= ERROR_ANOMALY_DELTA_THRESHOLD;

    return {
      serviceId,
      sampleCount: count,
      validLatencyCount,
      validErrorRateCount,
      averageLatency: Math.round(averageLatency * 100) / 100,
      baselineLatency,
      latencyRatio: Math.round(latencyRatio * 100) / 100,
      averageErrorRate: Math.round(averageErrorRate * 100) / 100,
      baselineErrorRate,
      errorRateDelta: Math.round(errorRateDelta * 100) / 100,
      firstAnomalousStep,
      hasLatencyAnomaly,
      hasErrorAnomaly,
      hasValidLatency: validLatencyCount > 0,
      hasValidErrorRate: validErrorRateCount > 0,
    };
  }

  /**
   * Aggregates telemetry maps for all services into an indexed HashMap.
   * Complexity: O(S * W), where S is service count and W is window size.
   */
  public analyzeAllServices(
    telemetryByService: Map<string, TelemetryPoint[]>,
    baselines: Map<string, { latency: number; errorRate: number }>
  ): Map<string, SlidingWindowStats> {
    const results = new Map<string, SlidingWindowStats>();

    for (const [serviceId, samples] of telemetryByService.entries()) {
      const baseline = baselines.get(serviceId) ?? { latency: 20, errorRate: 0.1 };
      const stats = this.analyzeServiceWindow(
        serviceId,
        samples,
        baseline.latency,
        baseline.errorRate
      );
      results.set(serviceId, stats);
    }

    return results;
  }
}
