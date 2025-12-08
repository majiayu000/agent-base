// ============================================================================
// Agent Base - Main Entry Point
// ============================================================================

// Core exports
export { Agent, createAgent } from './core/agent.js';
export type { AgentOptions } from './core/agent.js';

export { LLMClient, parseStream } from './core/llm-client.js';
export type { ParsedStreamResult } from './core/llm-client.js';

export { ContextManager } from './core/context-manager.js';
export type { ContextManagerOptions } from './core/context-manager.js';

export { ToolExecutor, ToolBuilder, createTool, defineTool } from './core/tool-executor.js';

// Type exports
export type {
  // Config
  AgentConfig,
  LLMClientConfig,
  // Messages
  Message,
  MessageRole,
  ToolCall,
  ToolCallFunction,
  // Tools
  Tool,
  ToolSchema,
  ToolParameter,
  ToolExecutionResult,
  // Events
  AgentEvents,
  // Results
  AgentResult,
  TokenUsageStats,
  // Content blocks
  ContentBlock,
  ThinkingBlock,
  TextBlock,
} from './core/types.js';

export { defaultConfig } from './core/types.js';

// Built-in tools
export {
  calculatorTool,
  currentTimeTool,
  jsonParserTool,
  stringUtilsTool,
  builtinTools,
} from './tools/builtin.js';

// HTTP tools
export {
  httpGetTool,
  httpPostTool,
  fetchJsonTool,
  httpTools,
} from './tools/http.js';

// Filesystem tools
export {
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  fileInfoTool,
  deleteTool,
  filesystemTools,
} from './tools/filesystem.js';

// Shell tools
export {
  shellExecTool,
  shellRunTool,
  commandExistsTool,
  shellTools,
} from './tools/shell.js';

// Utilities - Logger
export {
  Logger,
  createLogger,
  logger,
} from './utils/logger.js';
export type {
  LogLevel,
  LogEntry,
  LoggerOptions,
} from './utils/logger.js';

// Utilities - Middleware
export {
  loggingMiddleware,
  timingMiddleware,
  rateLimitMiddleware,
  retryMiddleware,
  costTrackingMiddleware,
  MiddlewareRunner,
} from './utils/middleware.js';
export type {
  MiddlewareContext,
  AgentMiddleware,
} from './utils/middleware.js';

// Utilities - Validation
export {
  zodToJsonSchema,
  createValidatedTool,
  withValidation,
  formatValidationError,
  safeParse,
  commonSchemas,
  validatedCalculatorTool,
} from './utils/validation.js';

// Utilities - Token Tracker
export {
  TokenTracker,
  tokenTracker,
  MODEL_PRICING,
} from './utils/token-tracker.js';
export type {
  ModelPricing,
  UsageRecord,
  UsageSummary,
} from './utils/token-tracker.js';

// LLM Client Token Usage
export type { TokenUsage } from './core/llm-client.js';

// Export tool result types
export type { HttpResponse } from './tools/http.js';
export type { ShellResult } from './tools/shell.js';

// All tools combined - import and re-export for convenience
import { builtinTools as _builtinTools } from './tools/builtin.js';
import { httpTools as _httpTools } from './tools/http.js';
import { filesystemTools as _filesystemTools } from './tools/filesystem.js';
import { shellTools as _shellTools } from './tools/shell.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const allTools: any[] = [
  ..._builtinTools,
  ..._httpTools,
  ..._filesystemTools,
  ..._shellTools,
];

// Agentic Design Patterns
export {
  Reflection,
  createReflection,
  reflectionMiddleware,
  Planner,
  createPlanner,
  MemoryStore,
  createMemoryStore,
  Router,
  createRouter,
  createAgentRoute,
  Guardrails,
  createGuardrails,
  createDefaultGuardrails,
  builtinRules,
  HumanInTheLoop,
  createHITL,
  requireApproval,
} from './patterns/index.js';

export type {
  ReflectionConfig,
  ReflectionResult,
  EvaluationResult,
  PlanStep,
  Plan,
  PlanningConfig,
  PlanningResult,
  MemoryEntry,
  MemorySearchResult,
  MemoryConfig,
  MemoryStats,
  Route,
  RoutingDecision,
  RouterConfig,
  RoutingResult,
  GuardrailRule,
  GuardrailViolation,
  GuardrailResult,
  GuardrailsConfig,
  ApprovalRequest,
  ApprovalResponse,
  HITLConfig,
  HITLResult,
} from './patterns/index.js';
