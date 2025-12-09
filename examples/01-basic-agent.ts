/**
 * Example 1: Basic Agent Usage
 *
 * This example shows how to create a simple agent with tools
 * and run it with streaming responses.
 */

import { createAgent, createTool, calculatorTool, currentTimeTool } from '../src/index.js';

// Create a custom tool
const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get the current weather for a location',
  parameters: {
    type: 'object',
    properties: {
      location: {
        type: 'string',
        description: 'The city name',
      },
    },
    required: ['location'],
  },
  execute: async (args) => {
    const { location } = args as { location: string };
    // Simulated weather data
    return {
      location,
      temperature: Math.floor(Math.random() * 30) + 10,
      condition: ['sunny', 'cloudy', 'rainy'][Math.floor(Math.random() * 3)],
    };
  },
});

async function main() {
  // Create agent with tools
  const agent = createAgent({
    model: 'gpt-4o-mini', // or any LiteLLM compatible model
    systemPrompt: 'You are a helpful assistant that can check the weather and do calculations.',
    tools: [calculatorTool, currentTimeTool, weatherTool],
    maxIterations: 5,
  });

  console.log('Agent created. Running query...\n');

  // Run agent with streaming
  const result = await agent.run(
    'What is the weather in Tokyo? Also, calculate 15 * 23.',
    {
      onToolCall: (name, args) => {
        console.log(`[Tool Call] ${name}:`, args);
      },
      onToolResult: (name, result) => {
        console.log(`[Tool Result] ${name}:`, result);
      },
    }
  );

  console.log('\n--- Final Result ---');
  console.log('Response:', result.response);
  console.log('Iterations:', result.iterations);
  console.log('Token Usage:', result.tokenUsage);
}

main().catch(console.error);
