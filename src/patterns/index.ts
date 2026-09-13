// ============================================================================
// Agentic Design Patterns - Pattern implementations
// ============================================================================

export {
  Reflection,
  createReflection,
  reflectionMiddleware,
} from './reflection.js';

export type {
  ReflectionConfig,
  ReflectionResult,
  EvaluationResult,
} from './reflection.js';

export {
  Planner,
  createPlanner,
} from './planning.js';

export type {
  PlanStep,
  Plan,
  PlanningConfig,
  PlanningResult,
} from './planning.js';

export {
  MemoryStore,
  createMemoryStore,
} from './memory.js';

export type {
  MemoryEntry,
  MemorySearchResult,
  MemoryConfig,
  MemoryStats,
} from './memory.js';

export {
  Router,
  createRouter,
  createAgentRoute,
} from './routing.js';

export type {
  Route,
  RoutingDecision,
  RouterConfig,
  RoutingResult,
} from './routing.js';

export {
  Guardrails,
  createGuardrails,
  createDefaultGuardrails,
  builtinRules,
  promptInjectionRule,
  piiDetectionRule,
  xssSanitizeRule,
  contentLengthRule,
  toxicContentRule,
} from './guardrails.js';

export type {
  GuardrailRule,
  GuardrailViolation,
  GuardrailResult,
  GuardrailsConfig,
} from './guardrails.js';

export {
  HumanInTheLoop,
  createHITL,
  requireApproval,
} from './human-in-the-loop.js';

export type {
  ApprovalRequest,
  ApprovalResponse,
  HITLConfig,
  HITLResult,
} from './human-in-the-loop.js';

export {
  PromptChain,
  createChain,
  createStep,
  ChainBuilder,
  chainBuilder,
  executeParallel,
  executeConditional,
} from './chaining.js';

export type {
  ChainStep,
  ChainContext,
  ChainStepResult,
  ChainResult,
  ChainConfig,
} from './chaining.js';

export {
  MultiAgentCoordinator,
  createCoordinator,
  createWorker,
  createRole,
  roundRobinStrategy,
  capabilityStrategy,
  SupervisorWorkerPattern,
  PipelinePattern,
  DebatePattern,
} from './multi-agent.js';

export type {
  AgentRole,
  AgentTask,
  AgentMessage,
  AgentWorker,
  MultiAgentContext,
  CoordinationStrategy,
  MultiAgentConfig,
  MultiAgentResult,
} from './multi-agent.js';

export {
  KnowledgeBase,
  createKnowledgeBase,
  HybridRetriever,
  createHybridRetriever,
  Reranker,
  createReranker,
} from './rag.js';

export type {
  Document,
  Chunk,
  RetrievalResult,
  RAGConfig,
  RAGContext,
} from './rag.js';

export {
  Evaluator,
  createEvaluator,
  createDefaultEvaluator,
  Monitor,
  createMonitor,
  lengthCriteria,
  relevanceCriteria,
  completenessCriteria,
  formatCriteria,
  builtinCriteria,
} from './evaluation.js';

export type {
  MetricValue,
  EvaluationCriteria,
  MonitorConfig,
  MonitorStats,
} from './evaluation.js';

export {
  ChainOfThought,
  TreeOfThought,
  SelfConsistency,
  ReActReasoner,
  createCoT,
  createToT,
  createSelfConsistency,
  createReAct,
} from './reasoning.js';

export type {
  ReasoningStep,
  ReasoningResult,
  ReasoningConfig,
} from './reasoning.js';
