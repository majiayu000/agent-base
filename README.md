# Agent Base

A comprehensive TypeScript framework for building AI agents with 11 Agentic Design Patterns.

## Features

- **Core Agent System**: Flexible agent with tool execution, context management, and streaming support
- **Built-in Tools**: HTTP, filesystem, shell, and utility tools
- **11 Agentic Design Patterns**: Production-ready implementations
- **Type-Safe**: Full TypeScript support with comprehensive types
- **Middleware Support**: Logging, rate limiting, retry, cost tracking

## Installation

```bash
bun install
```

## Quick Start

```typescript
import { createAgent, calculatorTool, currentTimeTool } from 'agent-base';

const agent = createAgent({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-sonnet-4-20250514',
  tools: [calculatorTool, currentTimeTool],
});

const result = await agent.run('What is 25 * 4?');
console.log(result.content);
```

## Agentic Design Patterns

### 1. Reflection Pattern
Self-evaluation and iterative improvement of outputs.

```typescript
import { createReflection } from 'agent-base';

const reflection = createReflection({
  maxIterations: 3,
  minScore: 0.8,
});

const result = await reflection.reflect(
  initialOutput,
  async (output) => ({ score: 0.7, feedback: 'Needs more detail' }),
  async (output, feedback) => improvedOutput
);
```

### 2. Planning Pattern
Break complex tasks into executable steps.

```typescript
import { createPlanner } from 'agent-base';

const planner = createPlanner({ maxSteps: 10 });

const plan = await planner.createPlan(
  'Build a web scraper',
  async (task) => generateSteps(task)
);

await planner.executePlan(plan, async (step) => executeStep(step));
```

### 3. Memory Pattern
Store and retrieve information across interactions.

```typescript
import { createMemoryStore } from 'agent-base';

const memory = createMemoryStore({
  maxEntries: 1000,
  enableEmbeddings: true,
});

await memory.store('User prefers dark mode', { type: 'preference' });
const results = await memory.search('user preferences');
```

### 4. Routing Pattern
Direct requests to specialized handlers.

```typescript
import { createRouter, createAgentRoute } from 'agent-base';

const router = createRouter()
  .addRoute(createAgentRoute('code', codeAgent, ['programming', 'debug']))
  .addRoute(createAgentRoute('math', mathAgent, ['calculate', 'equation']));

const result = await router.route('Fix this Python bug');
```

### 5. Guardrails Pattern
Validate and sanitize inputs/outputs.

```typescript
import { createGuardrails, builtinRules } from 'agent-base';

const guardrails = createGuardrails()
  .addRule(builtinRules.promptInjection)
  .addRule(builtinRules.piiDetection)
  .addRule(builtinRules.contentLength);

const inputResult = await guardrails.validateInput(userInput);
const outputResult = await guardrails.validateOutput(agentOutput);
```

### 6. Human-in-the-Loop Pattern
Request human approval for sensitive operations.

```typescript
import { createHITL, requireApproval } from 'agent-base';

const hitl = createHITL({
  timeout: 300000,
  defaultAction: 'deny',
});

const approvedTool = requireApproval(
  dangerousTool,
  async (request) => promptUser(request)
);
```

### 7. Prompt Chaining Pattern
Sequential task execution with context passing.

```typescript
import { chainBuilder } from 'agent-base';

const result = await chainBuilder()
  .addStep('research', async (ctx) => await research(ctx.input))
  .addStep('analyze', async (ctx) => await analyze(ctx.results.research))
  .addStep('summarize', async (ctx) => await summarize(ctx.results.analyze))
  .build()
  .execute({ input: 'AI trends 2024' });
```

### 8. Multi-Agent Pattern
Coordinate multiple specialized agents.

```typescript
import { createCoordinator, createWorker, createRole } from 'agent-base';

const coordinator = createCoordinator({
  strategy: 'capability',
})
  .addWorker(createWorker('researcher', researchAgent, ['research']))
  .addWorker(createWorker('writer', writerAgent, ['write', 'edit']));

const result = await coordinator.execute({
  id: 'task-1',
  type: 'research-paper',
  description: 'Write about quantum computing',
});
```

### 9. RAG Pattern
Retrieval-Augmented Generation for knowledge-based responses.

```typescript
import { createKnowledgeBase } from 'agent-base';

const kb = createKnowledgeBase({
  chunkSize: 500,
  topK: 5,
});

await kb.addDocuments([
  { content: 'TypeScript is a typed superset of JavaScript...' },
  { content: 'Bun is a fast JavaScript runtime...' },
]);

const context = await kb.buildContext('What is TypeScript?');
const prompt = await kb.augmentPrompt('Explain TypeScript');
```

### 10. Evaluation & Monitoring Pattern
Assess output quality and track metrics.

```typescript
import { createEvaluator, createMonitor, builtinCriteria } from 'agent-base';

// Evaluation
const evaluator = createEvaluator({ passThreshold: 0.7 });
evaluator.addCriteriaList(builtinCriteria);

const result = await evaluator.evaluate(
  'What is AI?',
  'AI is artificial intelligence...'
);
console.log(result.score, result.passed);

// Monitoring
const monitor = createMonitor({
  alertThresholds: { error_rate: { max: 0.1 } },
  onAlert: (metric, value) => console.log(`Alert: ${metric} = ${value}`),
});

monitor.recordLatency('api_call', 150);
monitor.recordCount('requests');
const stats = monitor.getStats();
```

### 11. Reasoning Techniques Pattern
Advanced reasoning strategies for complex problems.

```typescript
import { createCoT, createToT, createReAct } from 'agent-base';

// Chain of Thought
const cot = createCoT({ maxSteps: 10 });
const result = await cot.reason(
  'What is 15% of 80?',
  async (prompt) => llm.generate(prompt)
);

// Tree of Thought
const tot = createToT({ branchingFactor: 3 });
const result = await tot.reason(
  'Best approach for this problem?',
  async (prompt) => llm.generate(prompt)
);

// ReAct (Reasoning + Acting)
const react = createReAct({ maxSteps: 5 });
react.registerTool('search', async (query) => searchWeb(query));
react.registerTool('calculate', async (expr) => evaluate(expr));

const result = await react.reason(
  'What is the population of Tokyo divided by 1000?',
  async (prompt) => llm.generate(prompt)
);
```

## Built-in Tools

### Utility Tools
- `calculatorTool` - Mathematical calculations
- `currentTimeTool` - Current date/time
- `jsonParserTool` - JSON parsing
- `stringUtilsTool` - String manipulation

### HTTP Tools
- `httpGetTool` - GET requests
- `httpPostTool` - POST requests
- `fetchJsonTool` - Fetch and parse JSON

### Filesystem Tools
- `readFileTool` - Read files
- `writeFileTool` - Write files
- `listDirectoryTool` - List directory contents
- `fileInfoTool` - Get file information
- `deleteTool` - Delete files/directories

### Shell Tools (SEC-07 fail-closed defaults)

Default exports `shellExecTool`, `shellRunTool`, and the shell entries inside
`allTools` / `shellTools` are **not usable as-is**: `shell_exec` denies every
command until you supply an allowlist, and `shell_run` is disabled. Migrate to
`createShellTools(...)` (or `createShellExecTool` / `createShellRunTool`) and
register those instances instead of relying on `allTools` for shell access.

```typescript
import { createShellTools, builtinTools, httpTools, filesystemTools } from 'agent-base';

const shell = createShellTools({
  allowedCommands: ['ls', 'pwd', 'echo'],
  allowedCwdRoots: [process.cwd()],
  // allowShellRun: true, // only if you intentionally need shell_run
});

const tools = [...builtinTools, ...httpTools, ...filesystemTools, ...shell];
```

- `createShellTools(policy)` / `createShellExecTool(policy)` / `createShellRunTool(policy)` — preferred
- `commandExistsTool` — Check command availability (unchanged)
- `shellExecTool` / `shellRunTool` — fail-closed convenience stubs; prefer `createShellTools`

## Middleware

```typescript
import {
  loggingMiddleware,
  timingMiddleware,
  rateLimitMiddleware,
  retryMiddleware,
  costTrackingMiddleware,
} from 'agent-base';

const agent = createAgent({
  // ... config
  middleware: [
    loggingMiddleware(),
    timingMiddleware(),
    rateLimitMiddleware({ maxRequests: 100, windowMs: 60000 }),
    retryMiddleware({ maxRetries: 3 }),
    costTrackingMiddleware(),
  ],
});
```

## Utilities

### Logger
```typescript
import { createLogger } from 'agent-base';

const logger = createLogger({ level: 'debug', prefix: 'MyAgent' });
logger.info('Agent started');
```

### Token Tracker
```typescript
import { tokenTracker } from 'agent-base';

tokenTracker.record('claude-sonnet-4-20250514', 1000, 500);
const summary = tokenTracker.getSummary();
console.log(`Total cost: $${summary.totalCost}`);
```

### Validation (with Zod)
```typescript
import { createValidatedTool, commonSchemas } from 'agent-base';

const validatedTool = createValidatedTool(
  myTool,
  z.object({
    url: commonSchemas.url,
    count: commonSchemas.positiveInt,
  })
);
```

## Project Structure

```
src/
├── core/
│   ├── agent.ts          # Main agent implementation
│   ├── llm-client.ts     # LLM API client
│   ├── context-manager.ts # Context/conversation management
│   ├── tool-executor.ts  # Tool execution engine
│   └── types.ts          # Type definitions
├── patterns/
│   ├── reflection.ts     # Reflection pattern
│   ├── planning.ts       # Planning pattern
│   ├── memory.ts         # Memory pattern
│   ├── routing.ts        # Routing pattern
│   ├── guardrails.ts     # Guardrails pattern
│   ├── human-in-the-loop.ts # HITL pattern
│   ├── chaining.ts       # Prompt chaining pattern
│   ├── multi-agent.ts    # Multi-agent pattern
│   ├── rag.ts            # RAG pattern
│   ├── evaluation.ts     # Evaluation & monitoring
│   └── reasoning.ts      # Reasoning techniques
├── tools/
│   ├── builtin.ts        # Utility tools
│   ├── http.ts           # HTTP tools
│   ├── filesystem.ts     # Filesystem tools
│   └── shell.ts          # Shell tools
└── utils/
    ├── logger.ts         # Logging utility
    ├── middleware.ts     # Middleware system
    ├── validation.ts     # Validation utilities
    └── token-tracker.ts  # Token/cost tracking
```

## Testing

```bash
# Run all tests
bun test

# Run specific test file
bun test tests/reasoning.test.ts

# Run with coverage
bun test --coverage
```

## Examples

See the `examples/` directory for comprehensive examples of each pattern:

- `01-basic-agent.ts` - Basic agent usage
- `02-reflection.ts` - Reflection pattern
- `03-planning.ts` - Planning pattern
- `04-memory.ts` - Memory pattern
- `05-routing.ts` - Routing pattern
- `06-guardrails.ts` - Guardrails pattern
- `07-human-in-the-loop.ts` - HITL pattern
- `08-chaining.ts` - Prompt chaining
- `09-multi-agent.ts` - Multi-agent coordination

## License

MIT

## References

- [Agentic Design Patterns](https://github.com/ginobefun/agentic-design-patterns-cn)
- [Anthropic Claude API](https://docs.anthropic.com/)
