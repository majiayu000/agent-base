/**
 * Example 5: Routing Pattern
 *
 * This example shows how to dynamically route requests
 * to different handlers based on content analysis.
 */

import { createRouter, createAgentRoute } from '../src/index.js';

async function main() {
  // Create a router
  const router = createRouter({
    defaultRoute: 'general',
    routingMode: 'keyword', // Use keyword-based routing
  });

  // Add routes
  router
    .addRoute({
      id: 'code-help',
      name: 'Code Assistant',
      description: 'Handles programming and code-related questions',
      keywords: ['code', 'programming', 'function', 'bug', 'error', 'typescript', 'javascript', 'python'],
      handler: async (input) => {
        return `[Code Assistant] I can help with your code question: "${input}"`;
      },
      priority: 10,
    })
    .addRoute({
      id: 'math-help',
      name: 'Math Assistant',
      description: 'Handles mathematical calculations and problems',
      keywords: ['calculate', 'math', 'equation', 'sum', 'multiply', 'divide', 'percentage'],
      handler: async (input) => {
        return `[Math Assistant] Let me help with that math problem: "${input}"`;
      },
      priority: 10,
    })
    .addRoute({
      id: 'general',
      name: 'General Assistant',
      description: 'Handles general questions',
      keywords: [],
      handler: async (input) => {
        return `[General Assistant] I'll help you with: "${input}"`;
      },
      priority: 1,
    });

  console.log('=== Routing Examples ===\n');

  // Test different inputs
  const testInputs = [
    'How do I fix this TypeScript error?',
    'Calculate 15% of 200',
    'What is the weather today?',
    'Help me debug this function',
    'What is the sum of 5 and 10?',
  ];

  for (const input of testInputs) {
    console.log(`Input: "${input}"`);
    const result = await router.route(input);
    console.log(`  Route: ${result.route?.name || 'None'}`);
    console.log(`  Confidence: ${(result.confidence * 100).toFixed(0)}%`);
    console.log(`  Response: ${result.result}`);
    console.log();
  }

  // Example with agent routes
  console.log('=== Agent Routes (Simulated) ===\n');

  // In real usage, you would pass actual agents
  const codeAgentRoute = createAgentRoute({
    id: 'code-agent',
    name: 'Code Agent',
    description: 'Specialized code assistant',
    keywords: ['code', 'programming'],
    // agent: codeAgent, // Would be a real agent
  });

  console.log('Created agent route:', codeAgentRoute.name);
  console.log('Keywords:', codeAgentRoute.keywords);

  // Routing statistics
  console.log('\n=== Routing Statistics ===\n');

  // Route a few more to build up stats
  await router.route('Write a JavaScript function');
  await router.route('Calculate the area of a circle');
  await router.route('Hello, how are you?');

  const stats = router.getStats();
  console.log('Total routed:', stats.totalRouted);
  console.log('By route:');
  for (const [routeId, count] of Object.entries(stats.byRoute)) {
    console.log(`  ${routeId}: ${count}`);
  }
  console.log('Average confidence:', (stats.averageConfidence * 100).toFixed(1) + '%');
}

main().catch(console.error);
