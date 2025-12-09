/**
 * Example 2: Reflection Pattern
 *
 * This example demonstrates self-evaluation and iterative improvement
 * of agent outputs using the Reflection pattern.
 */

import { createAgent, createReflection, reflectionMiddleware } from '../src/index.js';

async function main() {
  // Create a reflection instance
  const reflection = createReflection({
    evaluator: async (output) => {
      // Custom evaluation logic
      const hasCodeBlock = output.includes('```');
      const isLongEnough = output.length > 100;
      const hasBulletPoints = output.includes('-') || output.includes('•');

      const score =
        (hasCodeBlock ? 0.3 : 0) +
        (isLongEnough ? 0.4 : 0) +
        (hasBulletPoints ? 0.3 : 0);

      return {
        score,
        passed: score >= 0.7,
        feedback:
          score < 0.7
            ? 'Response should include code examples, be detailed, and use bullet points for clarity.'
            : 'Good response!',
        suggestions: score < 0.7 ? ['Add code examples', 'Use bullet points', 'Be more detailed'] : [],
      };
    },
    maxIterations: 3,
    minScore: 0.7,
  });

  // Method 1: Direct reflection
  console.log('=== Method 1: Direct Reflection ===\n');

  const initialOutput = 'TypeScript is a programming language.';
  const reflectionResult = await reflection.reflect(initialOutput, async (improved) => {
    // Simulate improvement based on feedback
    return (
      improved +
      `

Here's a more detailed explanation:

- TypeScript adds static typing to JavaScript
- It compiles to plain JavaScript
- Supports modern ES features

\`\`\`typescript
// Example
const greeting: string = "Hello, TypeScript!";
console.log(greeting);
\`\`\`
`
    );
  });

  console.log('Final output:', reflectionResult.finalOutput);
  console.log('Iterations:', reflectionResult.iterations);
  console.log('Final score:', reflectionResult.evaluations[reflectionResult.evaluations.length - 1]?.score);

  // Method 2: Using middleware with agent
  console.log('\n=== Method 2: Reflection Middleware ===\n');

  const agent = createAgent({
    model: 'gpt-4o-mini',
    systemPrompt: 'You are a helpful programming tutor.',
  });

  // Add reflection middleware
  agent.use(
    reflectionMiddleware({
      evaluator: async (output) => {
        const score = output.length > 200 ? 1.0 : 0.5;
        return {
          score,
          passed: score >= 0.7,
          feedback: score < 0.7 ? 'Please provide more detail' : 'Good!',
        };
      },
      maxIterations: 2,
    })
  );

  console.log('Agent with reflection middleware created.');
  console.log('Note: Run agent.run() with a query to see reflection in action.');
}

main().catch(console.error);
