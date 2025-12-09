# Agent Base Examples

This directory contains examples demonstrating the various features and patterns of the Agent Base framework.

## Running Examples

```bash
# Run any example with bun
bun run examples/01-basic-agent.ts

# Or with node (requires tsx)
npx tsx examples/01-basic-agent.ts
```

## Examples Overview

### Core Examples

| File | Description |
|------|-------------|
| `01-basic-agent.ts` | Basic agent setup with tools and streaming |

### Agentic Design Patterns

| File | Pattern | Description |
|------|---------|-------------|
| `02-reflection-pattern.ts` | Reflection | Self-evaluation and iterative output improvement |
| `03-planning-pattern.ts` | Planning | Multi-step task decomposition and execution |
| `04-memory-pattern.ts` | Memory | Short-term and long-term memory management |
| `05-routing-pattern.ts` | Routing | Dynamic request routing based on content |
| `06-guardrails-pattern.ts` | Guardrails | Input/output validation and safety filtering |
| `07-human-in-the-loop.ts` | HITL | Human approval workflows and intervention points |
| `08-chaining-pattern.ts` | Chaining | Sequential task execution with data transformation |
| `09-multi-agent-pattern.ts` | Multi-Agent | Coordinated agent collaboration |

## Pattern Quick Reference

### Reflection
```typescript
const reflection = createReflection({
  evaluator: async (output) => ({
    score: 0.8,
    passed: true,
    feedback: 'Good response',
  }),
  maxIterations: 3,
});

const result = await reflection.reflect(output, improveFunction);
```

### Planning
```typescript
const planner = createPlanner({
  stepExecutor: async (step, context) => {
    // Execute step
    return result;
  },
});

const result = await planner.executePlan(plan);
```

### Memory
```typescript
const memory = createMemoryStore();
memory.add({ content: 'User prefers dark mode', type: 'short-term' });
const results = memory.search('dark mode');
```

### Routing
```typescript
const router = createRouter();
router.addRoute({
  id: 'code-help',
  keywords: ['code', 'programming'],
  handler: async (input) => handleCodeQuestion(input),
});
const result = await router.route(input);
```

### Guardrails
```typescript
const guardrails = createDefaultGuardrails();
const result = await guardrails.check(input);
if (!result.passed) {
  console.log('Blocked:', result.violations);
}
```

### Human-in-the-Loop
```typescript
const hitl = createHITL({
  approvalHandler: async (request) => ({
    requestId: request.id,
    approved: true,
    respondedAt: new Date(),
  }),
});

const result = await hitl.requestApproval({
  type: 'action',
  description: 'Delete data',
  content: { id: 123 },
});
```

### Chaining
```typescript
const result = await chainBuilder<number>()
  .step('double', 'Double', async (x) => x * 2)
  .step('add10', 'Add 10', async (x) => x + 10)
  .execute(5); // Result: 20
```

### Multi-Agent
```typescript
const coordinator = createCoordinator()
  .registerWorker(researcher)
  .registerWorker(writer)
  .addTasks([
    { id: 'research', description: 'Research topic', input: 'AI' },
    { id: 'write', description: 'Write article', dependencies: ['research'] },
  ]);

const result = await coordinator.execute();
```

## Environment Variables

For examples that use LLM calls, set your API key:

```bash
export OPENAI_API_KEY=your-api-key
# or for LiteLLM
export LITELLM_API_KEY=your-api-key
export LITELLM_API_BASE=your-api-base
```
