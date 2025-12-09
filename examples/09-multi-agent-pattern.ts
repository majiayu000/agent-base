/**
 * Example 9: Multi-Agent Pattern
 *
 * This example demonstrates coordinated agent collaboration
 * using the Multi-Agent pattern.
 */

import {
  createCoordinator,
  createWorker,
  createRole,
  roundRobinStrategy,
  capabilityStrategy,
  SupervisorWorkerPattern,
  PipelinePattern,
  DebatePattern,
} from '../src/index.js';

async function main() {
  console.log('=== Basic Multi-Agent Coordination ===\n');

  // Create roles
  const researcherRole = createRole('researcher', 'Researcher', {
    description: 'Gathers and analyzes information',
    systemPrompt: 'You are a research specialist.',
    capabilities: ['research', 'analyze', 'gather'],
  });

  const writerRole = createRole('writer', 'Writer', {
    description: 'Creates written content',
    systemPrompt: 'You are a content writer.',
    capabilities: ['write', 'summarize', 'edit'],
  });

  const reviewerRole = createRole('reviewer', 'Reviewer', {
    description: 'Reviews and provides feedback',
    systemPrompt: 'You are a quality reviewer.',
    capabilities: ['review', 'feedback', 'approve'],
  });

  // Create workers
  const researcher = createWorker(researcherRole, async (task) => {
    console.log(`  [Researcher] Working on: ${task.description}`);
    await sleep(50);
    return { findings: ['fact1', 'fact2', 'fact3'], topic: task.input };
  });

  const writer = createWorker(writerRole, async (task, context) => {
    console.log(`  [Writer] Working on: ${task.description}`);
    const researchData = context.getTaskResult('research');
    await sleep(50);
    return {
      content: `Article based on ${(researchData as any)?.findings?.length || 0} findings`,
    };
  });

  const reviewer = createWorker(reviewerRole, async (task, context) => {
    console.log(`  [Reviewer] Working on: ${task.description}`);
    const content = context.getTaskResult('write');
    await sleep(50);
    return { approved: true, feedback: 'Great work!' };
  });

  // Create coordinator
  const coordinator = createCoordinator({
    maxConcurrentTasks: 2,
    strategy: capabilityStrategy,
    onTaskStart: (task) => console.log(`Starting: ${task.id}`),
    onTaskComplete: (task) => console.log(`Completed: ${task.id}`),
  })
    .registerWorker(researcher)
    .registerWorker(writer)
    .registerWorker(reviewer)
    .addTasks([
      { id: 'research', description: 'Research the topic', input: 'AI agents' },
      { id: 'write', description: 'Write article', input: null, dependencies: ['research'] },
      { id: 'review', description: 'Review the article', input: null, dependencies: ['write'] },
    ]);

  console.log('Executing tasks with dependencies...\n');
  const result = await coordinator.execute();

  console.log('\nResults:');
  console.log('  Success:', result.success);
  console.log('  Completed tasks:', result.stats.completedTasks);
  console.log('  Duration:', result.totalDurationMs, 'ms');

  console.log('\n=== Agent Messaging ===\n');

  const senderRole = createRole('sender', 'Sender', {
    description: 'Sends messages',
    systemPrompt: 'Send messages',
    capabilities: ['send'],
  });

  const receiverRole = createRole('receiver', 'Receiver', {
    description: 'Receives messages',
    systemPrompt: 'Receive messages',
    capabilities: ['receive'],
  });

  const receivedMessages: string[] = [];

  const sender = createWorker(senderRole, async (task, context) => {
    context.sendMessage({
      from: 'sender',
      to: 'receiver',
      type: 'notification',
      content: 'Hello from sender!',
    });
    return 'Message sent';
  });

  const receiver = createWorker(
    receiverRole,
    async () => 'Received',
    async (message) => {
      receivedMessages.push(message.content as string);
      console.log(`  [Receiver] Got message: ${message.content}`);
    }
  );

  const messageCoordinator = createCoordinator()
    .registerWorker(sender)
    .registerWorker(receiver)
    .addTask({ id: 'send', description: 'Send a message', input: null, assignedRole: 'sender' });

  await messageCoordinator.execute();
  console.log('Messages received:', receivedMessages);

  console.log('\n=== Supervisor-Worker Pattern ===\n');

  const supervisorRole = createRole('supervisor', 'Supervisor', {
    description: 'Supervises workers',
    systemPrompt: 'You supervise tasks',
    capabilities: ['supervise', 'coordinate'],
  });

  const supervisor = new SupervisorWorkerPattern(supervisorRole, async (task) => {
    console.log(`  [Supervisor] Coordinating: ${task.description}`);
    return { supervised: true, task: task.id };
  });

  const worker1Role = createRole('worker1', 'Worker 1', {
    description: 'Worker 1',
    systemPrompt: 'Worker',
    capabilities: ['process'],
  });

  supervisor.addWorker(
    createWorker(worker1Role, async (task) => {
      console.log(`  [Worker1] Processing: ${task.id}`);
      return { processed: true };
    })
  );

  supervisor.addTask({
    id: 'coordinate',
    description: 'Coordinate work',
    input: 'project',
    assignedRole: 'supervisor',
  });

  const supResult = await supervisor.execute();
  console.log('Supervisor result:', supResult.success);

  console.log('\n=== Pipeline Pattern ===\n');

  const pipeline = new PipelinePattern();

  pipeline.addStage(
    createWorker(
      createRole('stage1', 'Input Processing', {
        description: 'Process input',
        systemPrompt: '',
        capabilities: [],
      }),
      async (task, context) => {
        const input = (task.input as number) ?? 0;
        console.log(`  Stage 1: Received ${input}`);
        context.shared['value'] = input + 10;
        return context.shared['value'];
      }
    )
  );

  pipeline.addStage(
    createWorker(
      createRole('stage2', 'Transform', {
        description: 'Transform data',
        systemPrompt: '',
        capabilities: [],
      }),
      async (task, context) => {
        const value = context.shared['value'] as number;
        console.log(`  Stage 2: Processing ${value}`);
        context.shared['value'] = value * 2;
        return context.shared['value'];
      }
    )
  );

  pipeline.addStage(
    createWorker(
      createRole('stage3', 'Output', {
        description: 'Output data',
        systemPrompt: '',
        capabilities: [],
      }),
      async (task, context) => {
        const value = context.shared['value'] as number;
        console.log(`  Stage 3: Finalizing ${value}`);
        return `Final result: ${value}`;
      }
    )
  );

  console.log('Processing through pipeline (input: 5)...');
  const pipeResult = await pipeline.execute(5);
  console.log('Pipeline output:', pipeResult.results.get('stage-2'));

  console.log('\n=== Debate Pattern ===\n');

  const debate = new DebatePattern({ maxRounds: 2 });

  debate.addDebater(
    createWorker(
      createRole('pro', 'Pro Side', {
        description: 'Argues in favor',
        systemPrompt: '',
        capabilities: [],
      }),
      async (task) => {
        const ctx = task.input as { topic: string; round: number };
        return `[Pro Round ${ctx.round + 1}] AI will benefit humanity through automation and efficiency.`;
      }
    )
  );

  debate.addDebater(
    createWorker(
      createRole('con', 'Con Side', {
        description: 'Argues against',
        systemPrompt: '',
        capabilities: [],
      }),
      async (task) => {
        const ctx = task.input as { topic: string; round: number };
        return `[Con Round ${ctx.round + 1}] AI poses risks to employment and privacy.`;
      }
    )
  );

  debate.setJudge(
    createWorker(
      createRole('judge', 'Judge', {
        description: 'Renders verdict',
        systemPrompt: '',
        capabilities: [],
      }),
      async (task) => {
        const ctx = task.input as { topic: string; rounds: any[] };
        return `After ${ctx.rounds.length} rounds of debate on "${ctx.topic}", both sides made valid points. Verdict: Nuanced consideration required.`;
      }
    )
  );

  console.log('Conducting debate on "AI in Society"...\n');
  const debateResult = await debate.debate('AI in Society');

  console.log('Debate rounds:');
  debateResult.rounds.forEach((round, i) => {
    console.log(`  Round ${i + 1}:`);
    round.forEach((arg) => {
      console.log(`    ${arg.argument}`);
    });
  });
  console.log('\nVerdict:', debateResult.verdict);

  console.log('\n=== Coordination Strategies ===\n');

  // Round-robin demonstration
  const rrCoordinator = createCoordinator({
    strategy: roundRobinStrategy,
    maxConcurrentTasks: 1,
  })
    .registerWorker(
      createWorker(
        createRole('a', 'Agent A', { description: '', systemPrompt: '', capabilities: ['process'] }),
        async (task) => `A handled ${task.id}`
      )
    )
    .registerWorker(
      createWorker(
        createRole('b', 'Agent B', { description: '', systemPrompt: '', capabilities: ['process'] }),
        async (task) => `B handled ${task.id}`
      )
    )
    .addTasks([
      { id: 't1', description: 'Process task 1', input: 1 },
      { id: 't2', description: 'Process task 2', input: 2 },
      { id: 't3', description: 'Process task 3', input: 3 },
      { id: 't4', description: 'Process task 4', input: 4 },
    ]);

  const rrResult = await rrCoordinator.execute();
  console.log('Round-robin distribution:');
  rrResult.results.forEach((value, key) => {
    console.log(`  ${key}: ${value}`);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
