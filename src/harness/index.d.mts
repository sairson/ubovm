import type { AgentEvent, AgentTool, AgentToolResult, StreamFn, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api, Context, ImageContent, Model, SimpleStreamOptions, TextContent } from '@earendil-works/pi-ai';
import type { Browser, BrowserContext, LaunchOptions } from 'playwright-core';
import type { Duplex } from 'node:stream';
import type { Buffer } from 'node:buffer';

export type { AgentEvent, AgentTool, AgentToolResult, StreamFn, ThinkingLevel } from '@earendil-works/pi-agent-core';
export type { Api, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
export type Awaitable<T> = T | Promise<T>;
/** Host-only recovery policy. An interrupted read is recorded as an error so
 * the model can request fresh data; writes and unknown tools remain blocked. */
export type RecoverableAgentTool = AgentTool & { recovery?: 'retry-read-only' };
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Priority = 'high' | 'medium' | 'low';
export type IntentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';
export type AttemptStatus = Exclude<IntentStatus, 'pending'>;
export type HarnessStatus = 'idle' | 'running' | 'completed' | 'interrupted' | 'failed' | 'closed';
export type FactOutcome = 'confirmed' | 'negative' | 'partial' | 'blocked';
export type WorkerPhase = 'plan' | 'execute' | 'replan' | 'conclude' | 'done';

export interface Provenance {
  sourceType: string;
  noteIds?: string[];
  workerIds?: string[];
  toolCallIds?: string[];
}
export interface Intent {
  description: string;
  hint: string;
  priority: Priority;
  keyPoints: string[];
  status: IntentStatus;
  createdAt: string;
  updatedAt: string;
}
export interface Attempt {
  id: string;
  status: AttemptStatus;
  startedAt: string;
  completedAt?: string;
  error?: string;
  checkpoint?: JsonValue;
}
export interface BlackboardNode {
  id: string;
  kind: 'root' | 'intent' | 'fact';
  parentIds: string[];
  childIds: string[];
  createdAt: string;
  updatedAt: string;
  intent: Intent | null;
  attempts: Attempt[];
  fact: { content: string; createdAt: string; attemptId?: string } | null;
  /** Independent output fact; legacy snapshots may instead contain an embedded fact. */
  resultId?: string;
  /** Intent that atomically produced this fact. */
  producerId?: string;
  provenance: Provenance | null;
}
export type IntentNode = BlackboardNode & { kind: 'intent'; intent: Intent };
export interface BlackboardSnapshot {
  schemaVersion: 1;
  sessionId: string;
  goal: string;
  rootId: string;
  revision: number;
  nodes: BlackboardNode[];
}
export interface IntentSpec {
  id?: string;
  description: string;
  hint?: string;
  priority?: Priority;
  keyPoints?: string[];
  parentIds?: string[];
  provenance?: Provenance;
}
export interface FactSpec {
  id?: string;
  content: string;
  parentIds?: string[];
  provenance?: Provenance;
}
export interface BlackboardEvent { type: string; sessionId: string; revision: number }
export interface ContextNode {
  ref: string;
  kind: BlackboardNode['kind'];
  parents: string[];
  intent?: Pick<Intent, 'description' | 'hint' | 'priority' | 'keyPoints' | 'status'>;
  fact?: string;
  /** Structural evidence gaps; a null issue does not establish the overall goal. */
  assessment?: { unresolvedKeyPoints: string[]; completionIssue: string | null };
  result?: string;
  producer?: string;
  /** Detached, read-only observation of the latest running attempt, not verified evidence. */
  progress?: { phase: 'plan' | 'execute' | 'replan' | 'conclude' | 'done'; completedSteps: number; remainingSteps: number; currentStep?: string };
  attempts?: { count: number; latestStatus: AttemptStatus; failures: { attempt: number; status: 'failed' | 'interrupted'; error?: string }[] };
  evidence?: { sourceType: string; noteCount: number; workerCount: number; toolCallCount: number };
}
export interface BlackboardContext {
  revision: number;
  data: { revision: number; goal: string; root: string; focus?: string; nodes: ContextNode[]; exploration?: ExplorationIndex };
  text: string;
  /** Resolve a model-facing alias (n1, n2, ...) into the durable node ID. */
  resolveId(alias: string): string;
  aliasFor(id: string): string;
}
/** Navigation over structured Worker results; eligibility is not proof of goal completion. */
export interface ExplorationIndex {
  findings: { ref: string; statement: string; outcome: string; completionEligible: boolean }[];
  gaps: { ref: string; unresolvedKeyPoints: string[]; nextSteps: string[]; followUpRefs: string[] }[];
  /** Follow-up lifecycle only; no state automatically closes a source gap. */
  frontier: { sourceRef: string; status: 'unassigned' | 'in_progress' | 'review_results' | 'needs_replan'; activeRefs: string[]; resultRefs: string[]; failedRefs: string[] }[];
  activeIntents: string[];
  failedIntents: string[];
}
export class Blackboard {
  constructor(options: { sessionId: string; goal: string; persist?: (snapshot: BlackboardSnapshot) => Awaitable<void> });
  static open(options: { filePath: string; sessionId?: string; goal?: string }): Promise<Blackboard>;
  static fromSnapshot(options: { snapshot: BlackboardSnapshot; persist?: (snapshot: BlackboardSnapshot) => Awaitable<void> }): Blackboard;
  snapshot(): BlackboardSnapshot;
  node(id: string): BlackboardNode | undefined;
  pendingIntents(): IntentNode[];
  verifyRevision(expectedRevision: number): Promise<number>;
  subscribe(listener: (event: BlackboardEvent) => unknown): () => boolean;
  createIntent(spec: IntentSpec): Promise<IntentNode>;
  createIntents(specs: IntentSpec[], options?: { expectedRevision?: number }): Promise<IntentNode[]>;
  createFact(spec: FactSpec): Promise<BlackboardNode>;
  updateHint(id: string, hint: string): Promise<IntentNode>;
  mergeProvenance(id: string, provenance: Provenance): Promise<BlackboardNode>;
  beginAttempt(id: string): Promise<Attempt>;
  completeAttempt(id: string, attemptId: string, content: string, options?: { provenance?: Provenance }): Promise<IntentNode>;
  failAttempt(id: string, attemptId: string, error: string | Error, options?: { interrupted?: boolean }): Promise<IntentNode>;
  saveCheckpoint(id: string, attemptId: string, data: JsonValue): Promise<Attempt>;
  retryIntent(id: string): Promise<IntentNode>;
  recoverInterrupted(): Promise<IntentNode[]>;
}
export function buildBlackboardContext(snapshot: BlackboardSnapshot, options?: { focusId?: string }): BlackboardContext;
export function normalizePriority(value?: unknown): Priority;
export function normalizeKeyPoints(values?: string[]): string[];
export function createContextMessage(snapshot: BlackboardSnapshot, options?: { focusId?: string }): { role: 'user'; content: string };

export type ReasonIntent = Omit<IntentSpec, 'id' | 'hint' | 'provenance'>;
export type ReasonDecision =
  | { wait: true }
  | { complete: true; summary: string; evidenceIds: string[]; intents?: [] }
  | { complete?: false; intents: ReasonIntent[] };
export interface ReasonInput { context: BlackboardContext; signal?: AbortSignal }
export type ReasonCallback = (input: ReasonInput) => Awaitable<ReasonDecision>;
export interface WorkerInput {
  node: IntentNode;
  attempt: Attempt;
  checkpoint?: JsonValue;
  signal?: AbortSignal;
  getContext(): BlackboardContext;
  getMessages(): Array<{ type: 'goal_completed'; completion: CoordinatorResult }>;
  onMessage(listener: (message: { type: 'goal_completed'; completion: CoordinatorResult }) => void): () => void;
  saveCheckpoint(checkpoint: JsonValue): Promise<Attempt>;
}
export interface WorkerResult { content: string; provenance?: Provenance }
export type WorkerCallback = (input: WorkerInput) => Awaitable<string | WorkerResult>;
export interface CoordinatorResult { complete: true; evidenceIds: string[]; summary: string; rounds: number; revision: number }
export interface RunOptions { resume?: boolean; signal?: AbortSignal }
export class BlackboardCoordinator {
  constructor(options: { blackboard: Blackboard; reason: ReasonCallback; worker: WorkerCallback; maxConcurrency?: number; maxRounds?: number;
    /** Per-attempt deadline in ms; 0 (default) disables the watchdog. */
    workerTimeoutMs?: number;
    /** In-run requeues per intent after a failed attempt; 0 (default) keeps failures on the board for Reason. */
    maxWorkerRetries?: number });
  readonly blackboard: Blackboard;
  readonly reason: ReasonCallback;
  readonly worker: WorkerCallback;
  readonly maxConcurrency: number;
  readonly maxRounds: number;
  readonly workerTimeoutMs: number;
  readonly maxWorkerRetries: number;
  run(options?: RunOptions): Promise<CoordinatorResult>;
}

export type GetApiKey = (provider: string) => Awaitable<string | undefined>;
export type ModelStreamOptions = Pick<SimpleStreamOptions,
  'temperature' | 'maxTokens' | 'timeoutMs' | 'maxRetries' | 'maxRetryDelayMs' | 'websocketConnectTimeoutMs' |
  'transport' | 'cacheRetention' | 'sessionId' | 'fetch' | 'onPayload' | 'onResponse' | 'samplingParams' |
  'metadata' | 'env' | 'reasoning' | 'thinkingBudgets' | 'toolChoice'>;
/** Select a catalog provider/modelId, a complete model, or an explicit custom endpoint. */
export interface ModelClientOptions {
  /** Pi Agent transport; the host owns tools, approvals and checkpoints. */
  backend?: 'pi';
  model?: Model<Api>;
  provider?: string;
  modelId?: string;
  api?: Api;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  compat?: Model<Api>['compat'];
  headers?: Record<string, string | null>;
  apiKey?: string;
  getApiKey?: GetApiKey;
  streamFn?: StreamFn;
  streamOptions?: ModelStreamOptions;
}
export interface ModelClient {
  readonly backend: 'pi';
  readonly model: Model<Api>;
  readonly streamFn: StreamFn;
  readonly getApiKey?: GetApiKey;
}
export function createModelClient(configuration: ModelClientOptions): ModelClient;

export interface WorkerPlanStep { description: string; doneWhen: string }
export interface WorkerPlan { done: boolean; steps: WorkerPlanStep[] }
export interface WorkerFact {
  version: 1;
  outcome: FactOutcome;
  statement: string;
  coverage: { point: string; status: FactOutcome; result: string }[];
  evidence: ({ toolCallId: string; nodeRef?: never; observation: string } | { nodeRef: string; toolCallId?: never; observation: string })[];
  failedChecks: string[];
  limitations: string[];
  /** Concrete remaining work; proposals, not evidence of completion. */
  nextSteps?: string[];
}
export interface ToolLedgerEntry {
  toolCallId: string;
  toolName: string;
  args: JsonValue;
  executedArgs?: JsonValue;
  status: 'running' | 'completed';
  isError?: boolean;
  result?: { content: (TextContent | ImageContent)[]; details?: JsonValue; terminate?: boolean };
}
export interface WorkerBinding { node: IntentNode; attempt: Attempt; signal?: AbortSignal }
export type ToolFactory = (binding: WorkerBinding) => Awaitable<RecoverableAgentTool[]>;
export interface WorkerHookInput extends WorkerBinding { phase: WorkerPhase }
export interface ModelRequestInput {
  scope: string;
  context: Context;
  signal?: AbortSignal;
  model?: Model<Api>;
  role?: 'reason' | 'worker';
  blackboard?: BlackboardContext['data'];
  ledger?: ToolLedgerEntry[];
  evidence?: { messageIndex: number; boardText?: string; ledgerText?: string };
  /** Host-selected messages to retain alongside system instructions and the latest user request. */
  protectedMessageIndexes?: number[];
}
export interface WorkerModelRequest extends ModelRequestInput, WorkerHookInput {
  role: 'worker';
  model: Model<Api>;
  blackboard: BlackboardContext['data'];
  ledger: ToolLedgerEntry[];
  evidence: { messageIndex: number; boardText: string; ledgerText: string };
}
export interface ReasonModelRequest extends ModelRequestInput {
  role: 'reason';
  model: Model<Api>;
  blackboard: BlackboardContext['data'];
  evidence: { messageIndex: number; boardText: string };
}
export interface WorkerProgress extends WorkerHookInput { plan: WorkerPlanStep[]; completed: { step: WorkerPlanStep; output: string }[] }
export type WorkerEvent = { intentId: string; attemptId: string; phase: WorkerPhase } & (
  | { type: 'worker_phase' }
  | { type: 'pi_event'; event: AgentEvent }
);
export interface WorkerAdapterOptions {
  tools?: RecoverableAgentTool[] | ToolFactory;
  thinkingLevel?: ThinkingLevel;
  systemPrompt?: string;
  /** Maximum model calls; default 0 means unlimited. */
  maxModelCalls?: number;
  /** Maximum tool calls; default 0 means unlimited. */
  maxToolCalls?: number;
  maxPlanSteps?: number;
  maxResponseBytes?: number;
  /** Defaults to 16 MiB. Capacity exhaustion stops this Worker before the next tool, without cancelling peers. */
  maxCheckpointBytes?: number;
  maxToolResultBytes?: number;
  /** Observational; use durable hooks below when execution must await your work. */
  onEvent?: (event: WorkerEvent) => unknown;
  completionBarrier?: (binding: WorkerBinding) => Awaitable<string | undefined>;
  contextProvider?: (binding: WorkerHookInput) => Awaitable<string | undefined>;
  /** Trusted host instructions, refreshed before each provider request. */
  instructionProvider?: (binding: WorkerHookInput) => Awaitable<string | undefined>;
  /** Transform the provider projection without changing durable checkpoints. */
  beforeModel?: (request: WorkerModelRequest) => Awaitable<Context>;
  onProgress?: (progress: WorkerProgress) => Awaitable<void>;
  onToolResult?: (input: WorkerHookInput & { entry: ToolLedgerEntry }) => Awaitable<void>;
}
export interface PiWorkerOptions extends WorkerAdapterOptions { model: Model<Api>; streamFn: StreamFn; getApiKey?: GetApiKey }
export interface WorkerOptions extends WorkerAdapterOptions { model?: ModelClientOptions }
export function createPiWorker(options: PiWorkerOptions): WorkerCallback;
export function parsePlan(text: string, options?: { maxSteps?: number; replan?: boolean }): WorkerPlan;
export function parseWorkerFact(text: string, options?: {
  keyPoints?: string[];
  ledger?: (Pick<ToolLedgerEntry, 'toolCallId' | 'status' | 'isError'> & Partial<ToolLedgerEntry>)[];
  context?: BlackboardContext;
  maxBytes?: number;
}): WorkerFact;

export interface ReasonAdapterOptions {
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
  maxIntents?: number;
  maxResponseBytes?: number;
  maxRepairs?: number;
  onEvent?: (event: ReasonEvent) => unknown;
  beforeModel?: (request: ReasonModelRequest) => Awaitable<Context>;
}
export type ReasonEvent = { revision: number } & (
  | { type: 'reason_start' }
  | { type: 'reason_repair'; attempt: number; error: string }
  | { type: 'reason_normalized'; fields: string[] }
  | { type: 'reason_decision'; decision: ReasonDecision; modelCalls: number }
  | { type: 'pi_event'; attempt: number; event: AgentEvent }
);
export interface PiReasonOptions extends ReasonAdapterOptions { model: Model<Api>; streamFn: StreamFn; getApiKey?: GetApiKey }
export interface ReasonOptions extends ReasonAdapterOptions { model?: ModelClientOptions }
export function createPiReason(options: PiReasonOptions): ReasonCallback;
export function parseReasonDecision(text: string, options: { context: BlackboardContext; maxIntents?: number; maxResponseBytes?: number }): ReasonDecision;

export interface HarnessError { name: string; code?: string; message: string }
export interface HarnessState {
  sessionId: string;
  goal: string;
  status: HarnessStatus;
  result: CoordinatorResult | null;
  error: HarnessError | null;
  runId: string | null;
  revision: number;
}
export interface EventEnvelope { sessionId: string; runId: string | null; sequence: number; timestamp: string }
export type HarnessEvent = EventEnvelope & (
  | { type: 'session.state'; state: HarnessState }
  | { type: 'session.cancel_requested'; reason: HarnessError }
  | { type: 'blackboard.changed'; event: BlackboardEvent }
  | { type: 'memory.changed'; revision: number }
  | { type: 'reason.start'; revision: number }
  | { type: 'reason.decision'; revision: number; decision: ReasonDecision }
  | { type: 'reason.error'; revision: number; error: HarnessError }
  | { type: 'reason.event'; event: ReasonEvent }
  | { type: 'worker.start'; intentId: string; attemptId: string }
  | { type: 'worker.goal_completed'; intentId: string; attemptId: string; completion: CoordinatorResult }
  | { type: 'worker.result'; intentId: string; attemptId: string; result: string | WorkerResult }
  | { type: 'worker.error'; intentId: string; attemptId: string; error: HarnessError }
  | { type: 'worker.event'; event: WorkerEvent }
  | { type: 'middleware.event'; event: ContextSummaryEvent | SkillsEvent }
);
export interface HarnessOptions {
  sessionId?: string;
  /** Required for a new session; omitted when reopening a persisted session. */
  goal?: string;
  /** Persistence directory owned by this session host. */
  directory?: string;
  /** Directory-backed sessions use SQLite by default; false retains legacy JSON files. */
  database?: false | true | HarnessDatabaseOptions | HarnessDatabase;
  /** Enabled by default. Uses the configured Reason model unless overridden. */
  contextSummary?: false | true | ContextSummaryOptions;
  mcp?: false | McpOptions;
  skills?: false | SkillsOptions;
  model?: ModelClientOptions;
  reason?: ReasonOptions | ReasonCallback;
  worker?: WorkerOptions | WorkerCallback;
  intools?: false | Omit<InternalToolsOptions, 'sessionId' | 'blackboard'>;
  tools?: RecoverableAgentTool[] | ToolFactory;
  onEvent?: (event: HarnessEvent) => unknown;
  maxConcurrency?: number;
  maxRounds?: number;
  /** Per-worker-attempt watchdog; default 3600000 (1 hour), 0 disables. */
  workerTimeoutMs?: number;
  /** Automatic in-run retries of failed attempts; default 1, 0 disables. */
  maxWorkerRetries?: number;
}
/** Construct using createHarness so durable state is loaded before use. */
export class HarnessSession {
  private constructor();
  readonly id: string;
  readonly goal: string;
  readonly status: HarnessStatus;
  readonly storage: { kind: 'sqlite' | 'json' | 'memory'; filePath?: string };
  run(options?: RunOptions): Promise<CoordinatorResult>;
  resume(options?: { signal?: AbortSignal }): Promise<CoordinatorResult>;
  cancel(reason?: unknown): boolean;
  close(): Promise<void>;
  subscribe(listener: (event: HarnessEvent) => unknown): () => boolean;
  snapshot(): BlackboardSnapshot;
  memory(): MemorySnapshot | undefined;
  getContext(options?: { focusId?: string }): BlackboardContext;
  getState(): HarnessState;
  events(options?: { afterSequence?: number; limit?: number }): HarnessEvent[];
  readEvidence(artifactId: string, options?: ReadContextEvidenceOptions): Promise<ContextEvidencePage>;
  middlewareStatus(): { mcp: McpDiagnostic[]; skills: SkillCatalogEntry[]; contextSummary: boolean };
  /** Host mutations require no running execution. */
  addIntent(spec: IntentSpec): Promise<IntentNode>;
  addFact(spec: FactSpec): Promise<BlackboardNode>;
  setHint(id: string, hint: string): Promise<IntentNode>;
  retryIntent(id: string): Promise<IntentNode>;
}
export function createHarness(options: HarnessOptions): Promise<HarnessSession>;

/** Collaboration uses conversational agents; createHarness retains the goal/Blackboard loop. */
export interface CollaborationAgentOptions {
  /** Desktop assistance only; defaults to true, changes apply next turn. */
  requireToolApproval?: boolean;
  model?: ModelClientOptions;
  thinkingLevel?: ThinkingLevel;
  systemPrompt?: string;
  /** Maximum model calls; default 0 means unlimited. */
  maxModelCalls?: number;
  /** Maximum tool calls; default 0 means unlimited. */
  maxToolCalls?: number;
}
export interface CollaborationHistoryLimits { maxHistoryMessages?: number; maxHistoryBytes?: number }
export interface CollaborationSettings extends CollaborationAgentOptions, CollaborationHistoryLimits {
  /** Defaults to fixed. Explicitly enable autonomous for per-worker Pi model selection. */
  backendSelection?: 'fixed' | 'autonomous';
  /** Host-approved models selectable via a Harness profile's modelProfile. */
  models?: Record<string, ModelClientOptions>;
  /** Shared executing worker limit, excluding workers waiting for descendants. Default 3. */
  maxConcurrency?: number;
  /** Newly spawned workers per turn across all levels. Default 12. */
  maxWorkers?: number;
  /** Worker levels below the root chat agent. Default 2. */
  maxDepth?: number;
}
export interface CollaborationBinding { node: { id: string }; workerId: string; signal: AbortSignal }
export interface CollaborationConfiguration {
  model?: ModelClientOptions;
  collaboration?: CollaborationSettings;
  worker?: CollaborationAgentOptions;
  /** Legacy model fallback and default model for context summarization. */
  reason?: ReasonOptions;
  maxConcurrency?: number;
  /** Legacy conversation history limits, overridden by collaboration settings. */
  assist?: CollaborationHistoryLimits;
  intools?: false | Omit<InternalToolsOptions, 'sessionId' | 'blackboard' | 'store' | 'canPromote'>;
  contextSummary?: false | true | ContextSummaryOptions;
  mcp?: false | McpOptions;
  skills?: false | SkillsOptions;
  tools?: RecoverableAgentTool[] | ((binding: CollaborationBinding) => Awaitable<RecoverableAgentTool[]>);
}
export type SwarmWorkerStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted';
export interface SwarmWorkerSnapshot {
  modelProfile?: string;
  id: string;
  parentId: string;
  name?: string;
  task: string;
  depth: number;
  status: SwarmWorkerStatus;
  result?: string;
  error?: string;
  resultTruncated?: boolean;
  taskTruncated?: boolean;
  errorTruncated?: boolean;
  nameTruncated?: boolean;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Cancellation was requested; running cleanup may still be in progress. */
  cancelRequestedAt?: number;
  cancelReason?: string;
  cancelReasonTruncated?: boolean;
}
export interface SwarmSnapshot {
  version: 1;
  sessionId: string;
  workers: SwarmWorkerSnapshot[];
  omittedWorkerCount?: number;
  omittedInterruptedWorkerCount?: number;
}
export interface SwarmStatusEvent {
  type: 'swarm.status';
  workers: SwarmWorkerSnapshot[];
  omittedWorkerCount?: number;
  omittedInterruptedWorkerCount?: number;
}
export type CollaborationEvent = { type: 'tool_approval'; toolCallId: string; toolName: string; approved: boolean } | AgentEvent | ContextSummaryEvent | SkillsEvent | SwarmStatusEvent | KnowledgeEvent
  | { type: 'agent.backend'; workerId: string; backend: 'pi'; modelId: string; modelProfile?: string }
  | { type: 'swarm.worker.event'; workerId: string; parentId: string; event: AgentEvent }
  | { type: 'middleware.status'; status: { contextSummary: boolean; mcp: McpDiagnostic[]; skills: SkillCatalogEntry[] } }
  | { type: 'memory.status'; memory: MemorySnapshot };
export interface ToolApprovalRequest { workerId: string; toolCallId: string; toolName: string; args: JsonValue; signal?: AbortSignal }
export interface CollaborationTurnOptions {
  /** Register the current root agent's steering handler; cleared when the turn ends. */
  registerSteering?: (handler: ((input: { text: string; context?: JsonValue }) => void) | undefined) => void;
  /** Host approval hook for every root/worker tool call. Only true permits execution. */
  requestToolApproval?: (request: ToolApprovalRequest) => Awaitable<boolean>;
  configuration?: CollaborationConfiguration;
  sessionId: string;
  /** Durable conversation directory (assist.sqlite, compatible with existing assist sessions). */
  directory: string;
  workspaceRoots?: string[];
  messages?: { role: 'user' | 'assistant'; text: string }[];
  text: string;
  context?: JsonValue;
  signal?: AbortSignal;
  onEvent?: (event: CollaborationEvent) => unknown;
}
export function runCollaboration(options: CollaborationTurnOptions): Promise<string>;
export interface SwarmOptions {
  sessionId: string;
  maxConcurrency?: number;
  maxWorkers?: number;
  maxDepth?: number;
  runWorker: (input: { workerId: string; parentId: string; task: string; depth: number; signal: AbortSignal; modelProfile?: string }) => Awaitable<string>;
  onEvent?: (event: SwarmStatusEvent) => unknown;
  signal?: AbortSignal;
  persist?: (snapshot: SwarmSnapshot) => Awaitable<void>;
  state?: SwarmSnapshot;
}
export interface SwarmRuntime {
  toolsFor(workerId?: string): AgentTool[];
  snapshot(): SwarmSnapshot;
  /** Await descendants, yielding the calling worker's concurrency slot while waiting. */
  settle(workerId?: string, signal?: AbortSignal): Promise<SwarmWorkerSnapshot[]>;
  /** Cancel every active worker and await cleanup. No saved work is replayed. */
  close(): Promise<void>;
  /** Live occupancy: who runs next, who can be preempted, which slots are releasing. */
  admission?(ownerId?: string): unknown;
  /** Live descendant snapshots plus derived blocked/releasing fields (not persisted). */
  inspect?(ownerId?: string): { workers: unknown[]; admission: unknown };
}
export function createSwarm(options: SwarmOptions): SwarmRuntime;

export interface HarnessDatabaseOptions {
  filePath: string;
  busyTimeoutMs?: number;
  leaseDurationMs?: number;
}
export interface StoredSessionRecord {
  schemaVersion: 1;
  sessionId: string;
  goal: string;
  status: Exclude<HarnessStatus, 'closed'>;
  runId: string | null;
  result: CoordinatorResult | null;
  error: HarnessError | null;
  createdAt?: string;
  startedAt?: string;
  updatedAt?: string;
}
export interface StoredSessionInfo {
  sessionId: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  eventSequence: number;
}
export interface StoredSession extends StoredSessionInfo {
  blackboard?: BlackboardSnapshot;
  memory?: MemorySnapshot;
  record?: StoredSessionRecord;
  recordRevision: number | null;
}
export interface SessionLease {
  readonly sessionId: string;
  readonly token: string;
  renew(): { sessionId: string; expiresAt: number };
  release(): boolean;
}
export interface RevisionCheck { expectedRevision?: number | null }
export interface DatabaseEvent {
  type: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  [key: string]: unknown;
}
/** Node 24 SQLite storage. All operations except open() are synchronous. */
export class HarnessDatabase {
  private constructor();
  static open(options: HarnessDatabaseOptions): Promise<HarnessDatabase>;
  readonly filePath: string;
  readonly schemaVersion: number;
  /** The callback must finish synchronously; nested transactions use savepoints. */
  transaction<T>(callback: (database: HarnessDatabase) => T extends PromiseLike<unknown> ? never : T): T;
  ensureSession(identity: { sessionId: string; goal: string }): StoredSessionInfo;
  loadSession(sessionId: string): StoredSession | undefined;
  saveBlackboard(sessionId: string, snapshot: BlackboardSnapshot): number;
  saveMemory(sessionId: string, snapshot: MemorySnapshot): number;
  saveRecord(sessionId: string, record: StoredSessionRecord, options?: RevisionCheck): number;
  /** Values are validated as finite, acyclic JSON at runtime. */
  saveContext(sessionId: string, key: string, value: unknown, options?: RevisionCheck): number;
  loadContext<T = JsonValue>(sessionId: string, key: string): T | undefined;
  contextState<T = JsonValue>(sessionId: string, key: string): { value: T; revision: number; updatedAt: string } | undefined;
  appendEvent<T extends { type: string; sessionId?: string; timestamp?: string }>(sessionId: string, event: T): T & DatabaseEvent;
  events<T extends { type: string } = DatabaseEvent>(sessionId: string, options?: { afterSequence?: number; limit?: number }): (T & DatabaseEvent)[];
  listSessions(options?: { limit?: number; offset?: number }): (StoredSessionInfo & { status: Exclude<HarnessStatus, 'closed'> })[];
  acquireSession(sessionId: string): SessionLease;
  renewSession(sessionId: string, token?: string): { sessionId: string; expiresAt: number };
  releaseSession(sessionId: string, token?: string): boolean;
  close(): void;
}

export interface ContextSummaryRequest {
  text: string;
  scope: string;
  kind: 'blackboard-fact' | 'tool-result' | 'transcript';
  maxTokens: number;
  signal: AbortSignal;
  /** Continuation-checkpoint instructions also used by the built-in model client. */
  instructions: string;
  /** UTF-16 source range; segments are contiguous and never split a surrogate pair. */
  sourceOffset: number;
  sourceLength: number;
  /** True when this request contains only one segment of the source evidence. */
  partial: boolean;
}
export type ContextSummaryEvent =
  | { type: 'context.summary_start'; scope: string; operationId: string; startedAt: number }
  | { type: 'context.summary_end'; scope: string; operationId: string; startedAt: number; endedAt: number; status: 'completed' | 'failed' | 'interrupted'; text: string; fallback: boolean; truncated: boolean; beforeTokens: number; afterTokens?: number }
  | { type: 'context.summary'; scope: string; kind: ContextSummaryRequest['kind']; artifactId: string; fallback: boolean; partial: boolean; truncated: boolean; coverage: ContextSummaryCoverage[] }
  /** Emitted for newly applied compression, never for unchanged or cached projections. */
  | { type: 'context.compacted'; scope: string; beforeTokens: number; afterTokens: number; summaryCalls: number };
/** Host-observed source coverage; summarized does not imply factual verification. */
export interface ContextSummaryCoverage {
  /** UTF-16 source range in the archived artifact. */
  offset: number;
  length: number;
  state: 'summarized' | 'truncated' | 'excerpt';
  reason?: 'summary_output_limit' | 'source_call_limit' | 'timeout' | 'summary_unavailable';
}
export interface ContextSummaryOptions {
  model?: ModelClientOptions;
  summarize?: (request: ContextSummaryRequest) => Awaitable<string>;
  triggerTokens?: number;
  targetTokens?: number;
  triggerMessages?: number;
  keepRecentMessages?: number;
  maxSummaryTokens?: number;
  maxSummaryCalls?: number;
  maxSummaryCallsPerScope?: number;
  maxSummaryInputTokens?: number;
  timeoutMs?: number;
  load?: (key: string) => Awaitable<JsonValue | undefined>;
  save?: (key: string, value: JsonValue) => Awaitable<void>;
  onEvent?: (event: ContextSummaryEvent) => unknown;
}
export interface ReadContextEvidenceOptions { scope?: string; offset?: number; limit?: number; signal?: AbortSignal }
export interface ContextEvidencePage {
  id: string;
  kind: ContextSummaryRequest['kind'];
  sha256: string;
  /** Pagination uses UTF-16 character offsets. */
  offset: number;
  total: number;
  text: string;
  nextOffset: number | null;
}
export interface ContextSummaryRuntime {
  transform(request: ModelRequestInput): Promise<Context>;
  readEvidence(id: string, options?: ReadContextEvidenceOptions): Promise<ContextEvidencePage>;
  tools(binding: WorkerBinding): Promise<AgentTool[]>;
  close(): Promise<void>;
}
export function createContextSummaryMiddleware(options?: ContextSummaryOptions): ContextSummaryRuntime;
export function estimateContextTokens(context: Context): number;

export type McpTransport = 'stdio' | 'streamable_http' | 'streamable-http' | 'sse';
export interface McpServerCommon {
  name: string;
  enabled?: boolean;
  required?: boolean;
  /** Remote tool names to expose. Omit to expose every discovered tool. */
  tools?: string[];
  toolNamePrefix?: string;
}
export interface McpStdioServer extends McpServerCommon {
  transport?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: never;
  headers?: never;
}
export interface McpHttpServer extends McpServerCommon {
  transport: 'streamable_http' | 'streamable-http' | 'sse';
  url: string;
  headers?: Record<string, string>;
  command?: never;
  args?: never;
  env?: never;
  cwd?: never;
}
export interface McpDisabledServer extends McpServerCommon { enabled: false; transport?: McpTransport }
export type McpServerOptions = McpStdioServer | McpHttpServer | McpDisabledServer;
export interface McpOptions {
  servers?: McpServerOptions[];
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  maxResultBytes?: number;
  signal?: AbortSignal;
}
export interface McpDiagnostic {
  name: string;
  transport: McpTransport;
  enabled: boolean;
  required: boolean;
  connected: boolean;
  tools: string[];
  error?: string;
}
export interface McpRuntime {
  readonly tools: readonly AgentTool[];
  diagnostics(): McpDiagnostic[];
  close(): Promise<void>;
}
export function createMcpMiddleware(options?: McpOptions): Promise<McpRuntime>;

export interface SkillCatalogEntry { name: string; description: string; directory: string; fingerprint: string }
export interface SkillsState {
  schemaVersion: 1;
  revision: number;
  workers: { workerId: string; skills: { name: string; fingerprint: string }[] }[];
}
export type SkillsBinding = WorkerBinding | { workerId: string; signal?: AbortSignal };
export interface SkillsEvent { type: 'skill.loaded'; workerId: string; name: string; revision: number }
export interface SkillsOptions {
  directories?: string[];
  skills?: { name?: string; directory: string }[];
  state?: SkillsState;
  persist?: (state: SkillsState) => Awaitable<void>;
  allowedSkills?: string[] | ((binding: SkillsBinding) => Awaitable<string[]>);
  maxSkills?: number;
  maxSkillBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
  maxActiveBytes?: number;
  maxWorkers?: number;
  resource?: { maxBytes?: number };
  script?: { defaultTimeoutSeconds?: number; maxTimeoutSeconds?: number; maxOutputBytes?: number };
  onEvent?: (event: SkillsEvent) => unknown;
}
export interface SkillsRuntime {
  tools(binding: SkillsBinding): Promise<AgentTool[]>;
  contextProvider(binding: SkillsBinding): Promise<string>;
  instructionProvider(binding: SkillsBinding): Promise<string>;
  list(): SkillCatalogEntry[];
  exportState(): SkillsState;
  importState(state: SkillsState): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}
export function createSkillsMiddleware(options?: SkillsOptions): Promise<SkillsRuntime>;

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export interface TodoItem { id: string; worker_id: string; content: string; status: TodoStatus; created_at: string; updated_at: string }
export interface MemoryNote {
  id: string;
  session_id: string;
  worker_id: string;
  content: string;
  note_type: 'note' | 'asset' | 'vulnerability';
  created_at: string;
  seen_count: number;
  last_seen_at: string;
  asset?: Record<string, JsonValue>;
  vulnerability?: Record<string, JsonValue>;
  contributor_worker_ids?: string[];
  promotion_kind?: 'fact' | 'intent';
  promotion_node_id?: string;
  promotion_status?: 'pending' | 'completed';
  promoted_at?: string;
}
export interface ToolEvidence {
  sessionId: string;
  workerId: string;
  attemptId: string;
  toolCallId: string;
  toolName: string;
  status: 'completed';
  isError: boolean;
  digest: string;
  observations: string;
  imageCount: number;
  learningInputKeys?: string[];
  /** Host-derived identity-independent execution hashes; absent on legacy records. */
  learningFingerprint?: string;
  learningRequestFingerprint?: string;
}
export interface MemorySnapshot {
  schemaVersion: 1;
  sessionId: string;
  revision: number;
  todos: TodoItem[];
  notes: MemoryNote[];
  promotions: { note_id: string; session_id: string; kind: 'fact' | 'intent'; node_id: string; status: 'pending' | 'completed'; spec: FactSpec | IntentSpec; created_at: string; updated_at: string; promoted_at?: string }[];
  workers: { worker_id: string; root_worker_id: string }[];
  audit: { type: string; note_id: string; note_type: string; source_worker: string; deleted_by: string; reason: string; created_at: string }[];
  toolEvidence?: ToolEvidence[];
  delivery?: DeliveryRecord;
  agentKnowledge?: { version: 1; lessons: KnowledgeLesson[]; reflectionKeys?: string[]; queue?: LearningQueueState };
}
export type DeliveryStage = 'develop' | 'audit' | 'security' | 'deploy' | 'operate';
export interface DeliveryEvidence { workerId: string; toolCallId: string; toolName: string; digest: string }
export interface DeliveryAcceptance {
  artifact: string; summary: string; evidence: DeliveryEvidence[];
  scope?: string; endpoint?: string; vantage?: string; rollback?: string; monitoring?: string; owner?: string;
}
export interface DeliveryRecord {
  revision: number; projectType: 'new-development'; objective: string; artifact: string;
  acceptance: Partial<Record<DeliveryStage, DeliveryAcceptance>>;
  blocked?: Partial<Record<DeliveryStage, { summary: string; owner: string }>>;
  findings: { id: string; severity: 'critical' | 'high' | 'medium' | 'low'; summary: string; evidence: DeliveryEvidence[];
    status: 'open' | 'resolved'; assessment?: { summary: string; evidence: DeliveryEvidence[]; artifact: string } }[];
  history: { revision: number; action: string; workerId: string; artifact: string; stage: string | null;
    findingId: string | null; summary: string | null; evidence: { workerId: string; toolCallId: string }[]; acceptance?: DeliveryAcceptance | null; at: string }[];
  evidenceFloor?: number; staleEvidence?: string[];
}
export interface LearningQueueState {
  version: 1;
  cursor: number;
  jobs: {
    id: string; kind: 'base' | 'reflection'; workerId: string;
    refs: { toolCallId: string; digest: string }[];
    status: 'pending' | 'running' | 'completed' | 'failed';
    attempts: number; nextAttemptAt: number; createdAt: number; completedAt?: number; error?: string; errorCode?: string;
    candidates?: KnowledgeCandidate[];
  }[];
  windows: { workerId: string; refs: { toolCallId: string; digest: string }[]; successes: boolean[]; unreflected: number;
    fingerprints?: (string | null)[]; reflectedFingerprints?: string[] }[];
}
export interface KnowledgeCandidate {
  title: string; trigger: string; steps: string[]; tool_call_ids: string[]; failure_call_ids?: string[]; portable?: boolean;
}
export interface KnowledgeOptions {
  maxLessons?: number;
  maxContextChars?: number;
  /** False disables shared persistence; the SDK otherwise opens only an explicitly configured file. */
  libraryFile?: string | false;
  maxSharedLessons?: number;
  background?: boolean;
  /** Host-managed tool-free model reflection; the desktop enables it by default. */
  reflection?: boolean;
  reflect?: (input: { records: ToolEvidence[]; previousLessons: RecalledKnowledgeLesson[]; signal: AbortSignal }) => Promise<KnowledgeCandidate[]>;
  maxPending?: number;
  maxReflections?: number;
  reflectionTimeoutMs?: number;
  reflectionIntervalMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  onEvent?: (event: KnowledgeEvent) => unknown;
}
export interface KnowledgeEvent {
  type: 'knowledge.learned' | 'knowledge.failed' | 'knowledge.deferred' | 'knowledge.reflection_start' | 'knowledge.reflection_end' | 'knowledge.recovered';
  workerId?: string;
  toolName?: string;
  message?: string;
  sessionId?: string;
  pending?: number;
  code?: string;
}
export interface KnowledgeLesson {
  id: string;
  workerId: string;
  title: string;
  trigger: string;
  steps: string[];
  status: 'candidate';
  evidence: { workerId: string; toolCallId: string; tool: string; digest: string; learningFingerprint?: string; learningRequestFingerprint?: string }[];
  failureEvidence?: KnowledgeLesson['evidence'];
  updatedAt: string;
}
export interface KnowledgeCapability {
  tool: string;
  successes: number;
  failures: number;
  lastFailed: boolean;
  lastFailure?: { workerId: string; toolCallId: string; observation: string };
  lastSuccess?: { workerId: string; toolCallId: string; observation: string };
  successRate: number;
  metric: 'tool-execution-only';
  distinctPracticeAttempts: number;
  novelObservations: number;
  unresolvedFailureRequests: number;
  failurePattern?: { count: number; workerId: string; toolCallId: string; observation: string };
  retryAdvice: 'none' | 'check-prerequisites' | 'change-method-or-prerequisite';
  needsPractice: boolean;
  score: number;
}
export interface SharedKnowledgeLesson {
  id: string;
  title: string;
  trigger: string;
  steps: string[];
  source: { sessionId: string; workerId: string; evidence: KnowledgeLesson['evidence']; failureEvidence?: KnowledgeLesson['evidence'] };
  updatedAt: string;
  successes: number;
  failures: number;
  familyId: string;
  parentId: string | null;
  familyFailures: number;
  independentSessions: number;
  needsValidation: boolean;
  status: 'candidate' | 'practiced' | 'needs-review';
  scope: 'library';
}
export type RecalledKnowledgeLesson = ((Omit<KnowledgeLesson, 'status'> & { scope: 'session'; status: 'candidate' | 'needs-review' }) | SharedKnowledgeLesson) & { score: number };
export interface KnowledgeWarning {
  id: string; title: string; status: 'candidate' | 'practiced' | 'needs-review';
  familyFailures: number; needsValidation: boolean; reason: string;
}
export class LearningLibrary {
  private constructor();
  static open(options: { filePath: string; maxLessons?: number }): Promise<LearningLibrary>;
  list(options?: { title: string; trigger: string }): SharedKnowledgeLesson[];
  registerSource(source: { filePath: string; sessionId: string; reflection?: boolean; enabled?: boolean }): void;
  sources(): { filePath: string; sessionId: string; reflection: boolean; enabled: boolean }[];
  publish(lesson: KnowledgeLesson, sessionId: string): { id: string; scope: 'library' };
  feedback(id: string, input: { sessionId: string; workerId: string; records: ToolEvidence[]; outcome: 'success' | 'failure' }): { id: string; outcome: 'success' | 'failure'; recorded: boolean };
  close(): void;
}
export function startLocalLearningRecovery(options: Pick<KnowledgeOptions, 'maxLessons' | 'maxSharedLessons' | 'maxContextChars' | 'maxPending' | 'maxAttempts' | 'retryBaseMs' | 'onEvent' | 'reflection'> & {
  libraryFile: string; storageDirectory?: string; intervalMs?: number; maxSourcesPerPass?: number;
}): Promise<{
  runOnce(): Promise<void>;
  status(): { running: boolean; paused: boolean; restored: number; busy: number; failures: number };
  pause(): Promise<() => void>;
  close(): Promise<void>;
}>;
export function createKnowledge(options: Pick<KnowledgeOptions, 'maxLessons' | 'maxContextChars'> & { store: MemoryStore; sessionId?: string; library?: LearningLibrary }): {
  readonly libraryAvailable: boolean;
  inspect(options?: { query?: string; limit?: number }): { libraryAvailable: boolean; capabilities: KnowledgeCapability[]; lessons: RecalledKnowledgeLesson[]; warnings: KnowledgeWarning[] };
  context(options?: { query?: string; signal?: AbortSignal }): Promise<string>;
  methods(options: { title: string; trigger: string }): ((KnowledgeLesson & { scope: 'session' }) | SharedKnowledgeLesson)[];
  tool(workerId: string): AgentTool;
};
export class MemoryStore {
  constructor(options: { sessionId: string; persist?: (snapshot: MemorySnapshot) => Awaitable<void> });
  static open(options: { filePath: string; sessionId?: string }): Promise<MemoryStore>;
  static fromSnapshot(options: { snapshot: MemorySnapshot; persist?: (snapshot: MemorySnapshot) => Awaitable<void> }): MemoryStore;
  readonly sessionId: string;
  snapshot(): MemorySnapshot;
  snapshot<K extends keyof MemorySnapshot>(fields: K[]): Pick<MemorySnapshot, K>;
  toolEvidence(workerId: string, toolCallId: string): ToolEvidence | undefined;
  toolCallIds(workerId: string): string[];
  knowledgeSnapshot(): { sessionId: string; agentKnowledge?: { version: 1; lessons: KnowledgeLesson[] } };
  deliverySnapshot(): (Omit<DeliveryRecord, 'staleEvidence' | 'evidenceFloor'> & { historyCount: number }) | undefined;
  deliveryHistory(options?: { offset?: number; limit?: number; expectedRevision?: number }): {
    revision: number; total: number; items: DeliveryRecord['history']; nextOffset: number | null;
  };
  subscribe(listener: (event: { revision: number }) => unknown): () => boolean;
  flush(): Promise<void>;
  commit<T>(mutate: (snapshot: MemorySnapshot) => T): Promise<T>;
  serial<T>(key: string, operation: () => Awaitable<T>): Promise<T>;
  registerWorker(workerId: string, options?: { rootWorkerId?: string }): Promise<void>;
}
export interface TodoTool extends AgentTool {
  syncPlan(owner: string, items: { id?: string; content: string; status?: TodoStatus }[]): Promise<void>;
  summary(owner?: string): string;
  promptSummary(owner?: string): string;
}
export interface NoteTool extends AgentTool { recoverPromotions(): Promise<string[]> }
export interface NoteEvidence {
  sessionId: string;
  workerId: string;
  toolCallId?: string;
  status: string;
  isError?: boolean;
}
export function createTodoTool(options: { store: MemoryStore; sessionId: string; workerId?: string }): TodoTool;
export function createDeliveryTool(options: { store: MemoryStore; sessionId: string; workerId?: string }): AgentTool & { summary(): string };
export function createNoteTool(options: {
  store: MemoryStore; sessionId: string; workerId?: string; blackboard?: Blackboard; canPromote?: boolean;
  evidenceProvider?: (binding: { toolCallId: string; sessionId: string; workerId: string }) => Awaitable<NoteEvidence | undefined>;
}): NoteTool;

export interface HTTPToolOptions { fetch?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number; maxRedirects?: number }
export interface WebSearchOptions extends HTTPToolOptions {
  /** Per-provider budget including retries/backoff; public providers run concurrently. Default: 15000 ms. */
  timeoutMs?: number;
  apiKey?: string;
  baseURL?: string;
  tavily?: { enabled?: boolean; apiKey?: string; baseURL?: string; projectID?: string; searchDepth?: 'basic' | 'advanced' | 'fast' | 'ultra-fast'; topic?: 'general' | 'news' | 'finance'; includeAnswer?: boolean };
  bingBaseURL?: string;
  duckDuckGoBaseURL?: string;
  fallbackToPublicProviders?: boolean;
  providerRetryAttempts?: number;
  retryBackoffMs?: number;
}
export interface FetchContentOptions extends HTTPToolOptions {
  lookup?: (hostname: string, options: { all: true; verbatim: true }) => Promise<{ address: string; family: number }[]>;
  allowPrivateAddresses?: boolean;
  allowedHost?: string;
  retryAttempts?: number;
  retryBackoffMs?: number;
}
export function createWebSearchTool(options?: WebSearchOptions): AgentTool;
export function createFetchTool(options?: FetchContentOptions): AgentTool;

export interface SkillDefinition { name: string; directory: string }
export class SkillRegistry {
  constructor(skills?: SkillDefinition[]);
  readonly skills: Map<string, Readonly<SkillDefinition>>;
  names(): string[];
  resolve(skill: string, path: string): Promise<{ path: string; directory: string }>;
}
export interface SkillResourceOptions { skills?: SkillDefinition[]; registry?: SkillRegistry; cwd?: string; maxBytes?: number }
export interface SkillScriptOptions { skills?: SkillDefinition[]; registry?: SkillRegistry; defaultTimeoutSeconds?: number; maxTimeoutSeconds?: number; maxOutputBytes?: number }
export function createSkillResourceTool(options?: SkillResourceOptions): AgentTool;
export function createSkillScriptTool(options?: SkillScriptOptions): AgentTool;

export interface SSHProfile {
  id?: string;
  name?: string;
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string | Buffer;
  private_key_file?: string;
  private_key_passphrase?: string;
  agent?: string;
  known_hosts_file?: string;
  host_key_sha256?: string;
  insecure_ignore_host_key?: boolean;
  connect_timeout_seconds?: number;
  default_command_timeout_seconds?: number;
  max_command_timeout_seconds?: number;
  max_output_bytes?: number;
}
export interface SSHProfileSummary { id: string; name: string; host: string; port: number; username: string; default: boolean }
export interface SSHInteractiveSession {
  stream: Duplex;
  write(data: string | Uint8Array): boolean;
  resize(columns: number, rows: number): void;
  close(): void;
}
export interface SSHConnection { end(): void; destroy(): void }
export class SSHCommands {
  constructor(config: SSHProfile);
  readonly maxCommandTimeoutSeconds: number;
  summary(isDefault?: boolean): SSHProfileSummary;
  connect(): Promise<SSHConnection>;
  waitForConnection(signal?: AbortSignal): Promise<SSHConnection>;
  execute(input: { command: string; timeout_seconds?: number; session?: string; reset_session?: boolean }, signal?: AbortSignal, onUpdate?: (result: AgentToolResult<unknown>) => void): Promise<AgentToolResult<unknown>>;
  openInteractive(options?: { columns?: number; rows?: number; signal?: AbortSignal }): Promise<SSHInteractiveSession>;
  close(): Promise<void>;
  tool(): AgentTool & { close(): Promise<void> };
}
export interface SSHCommandsPoolOptions { profiles?: SSHProfile[]; defaultId?: string }
export class SSHCommandsPool {
  constructor(options?: SSHCommandsPoolOptions);
  readonly defaultId?: string;
  get(id?: string): SSHCommands | undefined;
  require(id?: string): SSHCommands;
  summaries(): SSHProfileSummary[];
  close(): Promise<void>;
}
export function createSSHTool(options: SSHProfile | SSHCommands): AgentTool & { close(): Promise<void> };
export interface SFTPUploadInput { local_path: string; remote_path: string; timeout_seconds?: number; file_mode?: number }
export function uploadSFTP(commands: SSHCommands, input: SFTPUploadInput, signal?: AbortSignal, onUpdate?: (result: AgentToolResult<unknown>) => void): Promise<AgentToolResult<unknown>>;
export function createSFTPUploadTool(commands: SSHCommands): AgentTool;
export function createRemoteDeployTool(commands: SSHCommands): AgentTool;
export function shellQuote(value: unknown): string;
export function buildRemoteCommand(command: string, seconds?: number): string;
export function knownHostsVerifier(contents: string, host: string, port?: number): (key: Uint8Array) => boolean;

export type BrowserAction = 'status' | 'tabs' | 'tab_new' | 'tab_close' | 'tab_activate' | 'popup_policy' | 'console' | 'navigate' | 'back' | 'forward' | 'reload' |
  'accessibility' | 'snapshot' | 'click' | 'fill' | 'select' | 'check' | 'press' | 'hover' | 'scroll' | 'wait' | 'evaluate' |
  'cdp' | 'cdp_events' | 'cdp_detach' | 'network_start' | 'network' | 'network_body' | 'network_stop' |
  'script_scan' | 'sitemap_start' | 'sitemap' | 'sitemap_entry' | 'sitemap_clear' |
  'identity_capture' | 'identity_list' | 'identity_delete' | 'request_save' | 'request_replay' | 'object_catalog' | 'authz_compare' | 'screenshot';
export const BROWSER_ACTIONS: readonly BrowserAction[];
export type BrowserActionInput = { action: BrowserAction; timeout_seconds?: number; values?: string[]; mutations?: Record<string, unknown>; command_params?: Record<string, unknown> }
  & Partial<Record<'page_id' | 'url' | 'ref' | 'query' | 'role' | 'value' | 'key' | 'wait_for' | 'script' | 'pattern' | 'flags' | 'source' | 'name' | 'identity_ref' | 'owner_identity_ref' | 'other_identity_ref' | 'request_ref' | 'method' | 'request_id' | 'parent_id' | 'entry_id' | 'depth' | 'level', string>>
  & Partial<Record<'backend_node_id' | 'page' | 'page_size' | 'limit' | 'after_sequence' | 'max_bytes' | 'offset' | 'max_chars' | 'max_elements' | 'max_nodes' | 'max_matches' | 'max_source_chars' | 'max_candidates' | 'delta_x' | 'delta_y', number>>
  & Partial<Record<'clear' | 'include_text' | 'include_ignored' | 'include_anonymous' | 'include_credentials' | 'allow_unsafe' | 'checked' | 'full_page' | 'allow_popups', boolean>>;
export interface BrowserBinding { sessionId: string; workerId: string; target?: string }
export interface BrowserManagerOptions { browser?: Browser; context?: BrowserContext; executablePath?: string; channel?: string; cdpEndpoint?: string; launchOptions?: LaunchOptions }
export interface BrowserStatus {
  session_id?: string;
  worker_id?: string;
  source: 'obscura';
  manager_available: true;
  configured: boolean;
  available: boolean;
  connected: boolean;
  browser_action_available: boolean;
  isolated: true;
  state: 'closed' | 'connected' | 'configured' | 'not_configured';
  worker_page_id: string | null;
  guidance: string;
}
export interface BrowserBackend {
  status(binding?: Partial<BrowserBinding>): Awaitable<BrowserStatus>;
  call(binding: BrowserBinding, input: BrowserActionInput, signal?: AbortSignal): Awaitable<unknown>;
  close(): Awaitable<void>;
}
export class BrowserManager implements BrowserBackend {
  constructor(options?: BrowserManagerOptions);
  status(binding?: Partial<BrowserBinding>): Promise<BrowserStatus>;
  start(): Promise<void>;
  call(binding: BrowserBinding, input: BrowserActionInput, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}
export function createBrowserTools(options: BrowserBinding & { manager?: Pick<BrowserBackend, 'status' | 'call'> }): AgentTool[];

export type InternalToolName = 'delivery_workflow' | 'browser_action' | 'browser_connection_status' | 'fetch_web_content' | 'note' | 'todo' | 'web_search' | 'read_skills_resource' | 'run_local_skill_script' | 'run_linux_ssh_command' | 'run_local_shell_command' | 'run_python' | 'manage_python_environment' | 'upload_sftp' | 'deploy_remote_service' | 'learn_capability';
export const INTERNAL_TOOL_NAMES: readonly InternalToolName[];
export interface LocalShellOptions {
  cwd?: string;
  defaultTimeoutSeconds?: number;
  maxTimeoutSeconds?: number;
  maxOutputBytes?: number;
}
export function createLocalShellTool(options?: LocalShellOptions): AgentTool & { close(): Promise<void> };
export interface PythonToolOptions extends LocalShellOptions {
  /** Absolute CPython override; by default prefer bundled Python, then host PATH. */
  executable?: string;
  /** Hostnames the sandbox may reach. `*` (default) allows any host. */
  allowedDomains?: string[];
  /** Default false. Writes bypass IDE change snapshots when explicitly enabled. */
  allowWorkspaceWrite?: boolean;
  /** Default true: use the workspace's successfully synchronized environment. */
  useManagedEnvironment?: boolean;
}
export function createPythonTool(options?: PythonToolOptions): AgentTool;
export function createPythonEnvironmentTool(options?: PythonToolOptions): AgentTool;
export interface InternalToolsOptions {
  knowledge?: false | KnowledgeOptions;
  /** Host-provided session SQLite path for offline startup learning recovery. */
  learningSource?: string;
  localShell?: false | LocalShellOptions;
  /** Host-only command registration; return a cleanup callback. Interrupt targets one call, including a queued call. */
  onCommand?: (command: { id: string; workerId: string; toolCallId: string; name: string; interrupt(): boolean }) => void | (() => void);
  python?: false | PythonToolOptions;
  sessionId?: string;
  blackboard?: Blackboard;
  memoryFile?: string;
  store?: MemoryStore;
  browser?: false | BrowserManagerOptions;
  browserManager?: BrowserBackend;
  ssh?: SSHProfile | SSHCommandsPoolOptions;
  sshPool?: SSHCommandsPool;
  webSearch?: false | WebSearchOptions;
  fetchContent?: false | FetchContentOptions;
  skills?: SkillDefinition[];
  skillResource?: false | SkillResourceOptions;
  skillScript?: false | SkillScriptOptions;
  target?: string;
  allowedTools?: readonly InternalToolName[];
  canPromote?: boolean;
}
export interface InternalToolsHooks {
  tools: ToolFactory;
  contextProvider: NonNullable<WorkerAdapterOptions['contextProvider']>;
  onProgress: NonNullable<WorkerAdapterOptions['onProgress']>;
  onToolResult: NonNullable<WorkerAdapterOptions['onToolResult']>;
}
export interface InternalToolsRuntime extends InternalToolsHooks {
  learningStatus(): { pending: number; running: boolean; processed: number; failures: number; dropped: number; reflections: number; completed: number; failed: number } | undefined;
  flushLearning(): Promise<void>;
  readonly sessionId: string;
  readonly store: MemoryStore;
  readonly browserManager?: BrowserBackend;
  readonly sshPool?: SSHCommandsPool;
  readonly workerOptions: InternalToolsHooks;
  forWorker(workerId: string, options?: { rootWorkerId?: string; signal?: AbortSignal }): Promise<AgentTool[]>;
  close(): Promise<void>;
}
export function createInternalTools(options: InternalToolsOptions): Promise<InternalToolsRuntime>;
