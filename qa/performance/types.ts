/**
 * Level-2 performance schemas. Everything here is JSON-safe: `null` means "not measured / not
 * available in this browser", never zero. Every sample carries the workload it was taken under.
 */

export type MetricSource = 'browser' | 'backend' | 'simulator' | 'product';
export type MetricUnit = 'ms' | 'fps' | 'count' | 'bytes' | 'ratio' | 'per_s';

/** Which way is worse. `none` = diagnostic only (scales with load by design, e.g. message rate). */
export type Worse = 'higher' | 'lower' | 'none';

export type MetricKey =
  // browser
  | 'interaction_latency_ms'
  | 'event_timing_ms'
  | 'long_task_count'
  | 'long_task_max_ms'
  | 'tbt_ms'
  | 'tbt_per_s'
  | 'fps_mean'
  | 'fps_p10'
  | 'frames_over_33ms'
  | 'max_frame_gap_ms'
  | 'heap_used_bytes'
  | 'dom_nodes'
  | 'main_thread_busy_ratio'
  | 'script_busy_ratio'
  | 'page_errors'
  | 'console_errors'
  | 'failed_requests'
  | 'webgl_context_lost'
  | 'map_render_ms'
  | 'map_renders_per_s'
  // backend
  | 'api_health_rtt_ms'
  | 'api_state_rtt_ms'
  | 'api_failures'
  | 'socket_disconnects'
  | 'ws_msgs_per_s'
  // simulator
  | 'sim_tick_rate'
  // product
  | 'telemetry_age_ms'
  | 'fleet_convergence_ms'
  | 'video_live_ms'
  | 'map_ack_ms'
  | 'map_settle_ms';

export interface MetricSpec {
  source: MetricSource;
  unit: MetricUnit;
  worse: Worse;
  /** Used for baseline-relative regression (user-facing metrics only). */
  regression: boolean;
  /** Minimum margin above/below the baseline P95/P5 so a zero-IQR baseline does not flag noise. */
  floor: number;
  description: string;
}

/** Workload context attached to every measurement. */
export interface WorkloadContext {
  scenario_id: string;
  axis: WorkloadAxis;
  /** Value on the workload axis (drones, interaction interval ms, or soak seconds). */
  level: number;
  drones: number;
  sim_speed: number;
  /** Video streams started by this scenario and still active (safety limit applies to these). */
  scenario_video_streams: number;
  phase: 'baseline' | 'ramp' | 'refine' | 'confirm' | 'stress' | 'warmup' | 'soak' | 'trend';
}

export type WorkloadAxis = 'drones' | 'interaction_interval_ms' | 'elapsed_s';

export interface PerformanceSample {
  metric: MetricKey;
  source: MetricSource;
  value: number | null;
  unit: MetricUnit;
  /** Wall clock (ISO) and ms since the scenario's evidence recorder started. */
  t_wall: string;
  t_rel_ms: number;
  workload: WorkloadContext;
  window_id: string | null;
  unavailable_reason?: string;
  detail?: Record<string, unknown>;
}

// ------------------------------------------------------------------------------------ browser probe

export interface LoafScript {
  source: string;
  invoker: string;
  duration_ms: number;
  count: number;
}

/** What the in-page probe reports for one observation window. */
export interface BrowserWindowMetrics {
  duration_ms: number;
  frames: number;
  fps_mean: number | null;
  /** 10th percentile of per-second frame counts (low-percentile representative FPS). */
  fps_p10: number | null;
  fps_min_second: number | null;
  frames_over_33ms: number;
  max_frame_gap_ms: number | null;
  long_task_supported: boolean;
  long_tasks: number;
  long_task_max_ms: number;
  tbt_ms: number;
  loaf_supported: boolean;
  loaf: { count: number; blocking_ms: number; top_scripts: LoafScript[] } | null;
  event_timing_supported: boolean;
  event_timing_max_ms: number | null;
  memory_supported: boolean;
  heap_used_bytes: number | null;
  dom_nodes: number;
  ws_messages: number;
  ws_msgs_per_s: number;
  ws_opens: number;
  ws_closes: number;
  page_errors: number;
  unhandled_rejections: number;
  webgl_context_lost: number;
  socket_badge: string;
  map: { observable: boolean; renders: number; render_ms_mean: number | null; render_ms_max: number | null; track_points: number | null; entities: number | null; reason?: string };
}

export interface CdpWindowMetrics {
  task_busy_ratio: number | null;
  script_busy_ratio: number | null;
  layout_ms: number | null;
  recalc_style_ms: number | null;
  heap_used_bytes: number | null;
  nodes: number | null;
}

export interface ApiProbe {
  t_rel_ms: number;
  endpoint: 'health' | 'state';
  ok: boolean;
  status: number | null;
  rtt_ms: number;
  /** outage = network/502-504 (environment), http = other non-2xx, none = success. */
  failure: 'none' | 'outage' | 'http';
  error?: string;
}

export interface TelemetryProbe {
  t_rel_ms: number;
  device_id: string;
  header_matches_selected: boolean;
  /** Displayed values matched a frame received for the selected device. */
  matched_selected_device: boolean;
  /** Displayed values matched a frame of a DIFFERENT device (wrong-device telemetry). */
  matched_other_device: string | null;
  /** now - payload.timestamp of the newest matching frame. CROSS-CLOCK (simulator container vs browser): diagnostic only. */
  age_raw_ms: number | null;
  /** Browser clock: now - arrival of the newest frame whose values are on screen (UI staleness + stream gaps). */
  age_ms: number | null;
  /** now - browser arrival time of the newest frame for the device (same clock). */
  arrival_age_ms: number | null;
  frames_buffered: number;
}

export interface InteractionMeasurement {
  kind: 'select-device' | 'map-view';
  target: string;
  t_rel_ms: number;
  workload: WorkloadContext;
  /** ACTION_EXECUTED alone is never success; only POSTCONDITION_SATISFIED is. */
  stage: 'POSTCONDITION_SATISFIED' | 'POSTCONDITION_FAILED' | 'NOT_ACTIONABLE' | 'NOT_FOUND';
  /** In-page: click event timestamp -> first frame in which the postcondition holds. */
  latency_ms: number | null;
  /** Browser Event Timing duration of the click (processing + next paint), if supported. */
  event_timing_ms: number | null;
  /** map-view only: until the camera finished its flight at the target pitch. */
  settle_ms: number | null;
  /** Harness-side wall time from dispatch to observed postcondition (includes RPC overhead). */
  harness_wall_ms: number;
  detail?: Record<string, unknown>;
}

export interface WindowMetrics {
  id: string;
  workload: WorkloadContext;
  started_at: string;
  t_start_ms: number;
  t_end_ms: number;
  browser: BrowserWindowMetrics | null;
  cdp: CdpWindowMetrics | null;
  api: ApiProbe[];
  telemetry: TelemetryProbe[];
  simulator: { tick_start: number | null; tick_end: number | null; tick_rate_per_s: number | null; speed: number | null; running: boolean | null; drones: number | null };
  interactions: InteractionMeasurement[];
  console_errors: number;
  failed_requests: number;
  /** Flat, metric-keyed summary of this window used by invariants, baseline and correlation. */
  values: Partial<Record<MetricKey, number | null>>;
  unavailable: Partial<Record<MetricKey, string>>;
}

// ------------------------------------------------------------------------------------ invariants

/**
 * NOMINAL   within the target
 * ELEVATED  slower than nominal but not yet degraded (the explicit 150–300 ms gap for latency)
 * DEGRADED  user-perceivably worse, contract still held
 * BREACH    the user-facing contract itself is violated
 * UNAVAILABLE  metric could not be measured: never a pass, never a failure
 */
export type InvariantCategory = 'NOMINAL' | 'ELEVATED' | 'DEGRADED' | 'BREACH' | 'UNAVAILABLE';

export interface PerformanceInvariant {
  id: string;
  title: string;
  group: 'responsiveness' | 'freshness' | 'smoothness' | 'convergence' | 'stability' | 'memory';
  metric: MetricKey;
  /** Thresholds in metric units. For worse='lower', categories apply below the thresholds. */
  worse: 'higher' | 'lower';
  nominal: number;
  degraded: number;
  breach: number;
  /** Which window statistic is judged (latency: median of the window's interactions). */
  statistic: 'median' | 'max' | 'value';
  hard: boolean;
}

export interface InvariantResult {
  id: string;
  group: PerformanceInvariant['group'];
  metric: MetricKey;
  category: InvariantCategory;
  observed: number | null;
  thresholds: { nominal: number; degraded: number; breach: number; worse: 'higher' | 'lower' };
  reason?: string;
}

// ------------------------------------------------------------------------------------ baseline

export interface MetricStats {
  n: number;
  median: number;
  mean: number;
  min: number;
  max: number;
  p5: number;
  p95: number;
  q1: number;
  q3: number;
  iqr: number;
}

export interface MetricBaseline extends MetricStats {
  worse: Worse;
  /** Upper (or lower for worse='lower') edge of normal variance and of a regression. */
  normal_limit: number;
  regression_limit: number;
  sufficient: boolean;
}

export type BaselineClass = 'NORMAL_VARIANCE' | 'OUTLIER' | 'PERFORMANCE_REGRESSION' | 'INSUFFICIENT_BASELINE' | 'UNAVAILABLE';

export interface BaselineComparison {
  metric: MetricKey;
  classification: BaselineClass;
  observed: number[];
  normal_limit: number | null;
  regression_limit: number | null;
}

export interface PerformanceBaselineProfile {
  schema: 'cockpit-qa/perf-baseline@1';
  recorded_at: string;
  workload: { drones: number; sim_speed: number; faults: number };
  windows: number;
  window_ms: number;
  constants: { normal_iqr_k: number; regression_iqr_k: number; consecutive_windows: number; min_samples: number };
  metrics: Partial<Record<MetricKey, MetricBaseline>>;
  unavailable: MetricKey[];
  clock_offset_ms: number | null;
}

// ------------------------------------------------------------------------------------ ramp / result

export type StepVerdict = 'HEALTHY' | 'DEGRADED' | 'HARD_INVARIANT_BREACH' | 'INCONCLUSIVE';

export interface WorkloadStep {
  index: number;
  level: number;
  phase: WorkloadContext['phase'];
  started_at: string;
  windows: WindowMetrics[];
  invariants: InvariantResult[];
  baseline: BaselineComparison[];
  verdict: StepVerdict;
  /** A non-healthy first window that the confirmation window did not reproduce. */
  isolated_outliers: string[];
  /** Contracts already violated at the baseline workload (not counted as onset). */
  preexisting: string[];
  reasons: string[];
  pass: boolean;
}

export interface KneeResult {
  /** Largest tested level that passed with no failing level at or below it. */
  safe_capacity: number | null;
  /** Smallest level that failed. */
  degradation_onset: number | null;
  bracket: [number, number] | null;
  resolution: number;
  established: boolean;
  /** Why a boundary is (not) established: all-pass, baseline-fails, refined, truncated... */
  reason: string;
  non_monotonic: Array<{ level: number; verdict: StepVerdict }>;
  tested: Array<{ level: number; verdict: StepVerdict; pass: boolean }>;
}

export interface BottleneckSignal {
  id: 'backend' | 'frontend_main_thread' | 'transport_realtime' | 'map_rendering' | 'simulator' | 'memory';
  /** Always phrased "signals consistent with ..." unless direct evidence establishes it. */
  statement: string;
  strength: 'weak' | 'moderate' | 'strong';
  evidence: Record<string, unknown>;
}

export type PerformanceVerdict = 'HEALTHY' | 'DEGRADED' | 'HARD_INVARIANT_BREACH' | 'INCONCLUSIVE' | 'BLOCKED' | 'HARNESS_ERROR';

export interface CleanupReport {
  ok: boolean;
  actions: Array<{ action: string; ok: boolean; error?: string }>;
  leftovers: string[];
  verified_baseline: boolean | null;
  final_state?: { drones: string[]; speed: number | null; running: boolean | null };
}

export interface PerformanceResult {
  schema: 'cockpit-qa/performance@1';
  scenario_id: string;
  title: string;
  user_goal: string;
  workload_axis: WorkloadAxis;
  started_at: string;
  finished_at: string;
  environment: { cockpitUrl: string; apiUrl: string; browser: string; headless: boolean; renderer: string | null; notes: string[] };
  config: Record<string, unknown>;
  baseline: PerformanceBaselineProfile | null;
  recorded_baseline_drift: BaselineComparison[] | null;
  steps: WorkloadStep[];
  samples: PerformanceSample[];
  knee: KneeResult | null;
  verdict: PerformanceVerdict;
  verdict_reason: string;
  bottleneck_signals: BottleneckSignal[];
  unavailable_metrics: Partial<Record<MetricKey, string>>;
  safety: { limits: Record<string, number>; aborted: string | null; truncated: string | null; events: string[] };
  cleanup: CleanupReport | null;
  extra: Record<string, unknown>;
}

/** One `--perf` invocation over several scenarios. */
export interface PerformanceRun {
  schema: 'cockpit-qa/performance-run@1';
  run_id: string;
  started_at: string;
  finished_at: string;
  scenarios: Array<{ id: string; status: string; verdict: PerformanceVerdict; safe_capacity: number | null; degradation_onset: number | null; evidence_dir: string }>;
}
