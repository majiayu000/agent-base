import { describe, it, expect, beforeEach } from 'bun:test';
import {
  MultiAgentCoordinator,
  createCoordinator,
  createWorker,
  createRole,
  roundRobinStrategy,
  capabilityStrategy,
  SupervisorWorkerPattern,
  PipelinePattern,
  DebatePattern,
} from '../src/patterns/multi-agent.js';
import type { AgentTask, AgentWorker, AgentRole } from '../src/patterns/multi-agent.js';

describe('Multi-Agent Pattern', () => {
  // Helper roles and workers
  const createTestRole = (id: string, capabilities: string[] = []): AgentRole =>
    createRole(id, `${id} Role`, {
      description: `Test role ${id}`,
      systemPrompt: `You are ${id}`,
      capabilities,
    });

  const createTestWorker = (
    role: AgentRole,
    execute: (task: AgentTask) => Promise<unknown> = async (task) => task.input
  ): AgentWorker => createWorker(role, execute);

  describe('createCoordinator', () => {
    it('should create coordinator with default config', () => {
      const coordinator = createCoordinator();
      expect(coordinator).toBeInstanceOf(MultiAgentCoordinator);
    });

    it('should create coordinator with custom config', () => {
      const coordinator = createCoordinator({
        maxConcurrentTasks: 10,
        defaultTaskTimeoutMs: 30000,
        strategy: capabilityStrategy,
      });
      expect(coordinator).toBeInstanceOf(MultiAgentCoordinator);
    });
  });

  describe('createRole/createWorker', () => {
    it('should create a role', () => {
      const role = createRole('test', 'Test Role', {
        description: 'A test role',
        systemPrompt: 'You are a test agent',
        capabilities: ['testing', 'debugging'],
      });
      expect(role.id).toBe('test');
      expect(role.capabilities).toContain('testing');
    });

    it('should create a worker', () => {
      const role = createTestRole('worker');
      const worker = createWorker(role, async (task) => task.input);
      expect(worker.role).toBe(role);
    });
  });

  describe('registerRole/registerWorker', () => {
    it('should register roles and workers', () => {
      const coordinator = createCoordinator();
      const role = createTestRole('agent1');
      const worker = createTestWorker(role);

      coordinator.registerRole(role);
      coordinator.registerWorker(worker);

      expect(coordinator.getWorkers()).toHaveLength(1);
    });

    it('should support chaining', () => {
      const coordinator = createCoordinator()
        .registerWorker(createTestWorker(createTestRole('a1')))
        .registerWorker(createTestWorker(createTestRole('a2')));

      expect(coordinator.getWorkers()).toHaveLength(2);
    });
  });

  describe('addTask/addTasks', () => {
    it('should add tasks', () => {
      const coordinator = createCoordinator();
      coordinator.addTask({
        id: 't1',
        description: 'Test task',
        input: { data: 'test' },
      });

      expect(coordinator.getTasks()).toHaveLength(1);
      expect(coordinator.getTask('t1')?.status).toBe('pending');
    });

    it('should add multiple tasks', () => {
      const coordinator = createCoordinator();
      coordinator.addTasks([
        { id: 't1', description: 'Task 1', input: 1 },
        { id: 't2', description: 'Task 2', input: 2 },
        { id: 't3', description: 'Task 3', input: 3 },
      ]);

      expect(coordinator.getTasks()).toHaveLength(3);
    });
  });

  describe('execute - basic', () => {
    it('should execute tasks with workers', async () => {
      const role = createTestRole('processor');
      const worker = createWorker(role, async (task) => {
        return (task.input as number) * 2;
      });

      const coordinator = createCoordinator()
        .registerWorker(worker)
        .addTask({ id: 't1', description: 'Double', input: 5 })
        .addTask({ id: 't2', description: 'Double', input: 10 });

      const result = await coordinator.execute();

      expect(result.success).toBe(true);
      expect(result.results.get('t1')).toBe(10);
      expect(result.results.get('t2')).toBe(20);
      expect(result.stats.completedTasks).toBe(2);
    });

    it('should handle task failures', async () => {
      const role = createTestRole('failer');
      const worker = createWorker(role, async () => {
        throw new Error('Task failed');
      });

      const coordinator = createCoordinator()
        .registerWorker(worker)
        .addTask({ id: 't1', description: 'Fail', input: null });

      const result = await coordinator.execute();

      expect(result.success).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.stats.failedTasks).toBe(1);
    });

    it('should provide shared context', async () => {
      const role = createTestRole('context-user');
      const worker = createWorker(role, async (task, context) => {
        return (task.input as number) + (context.shared['offset'] as number);
      });

      const coordinator = createCoordinator()
        .registerWorker(worker)
        .addTask({ id: 't1', description: 'Add offset', input: 5 });

      const result = await coordinator.execute({ shared: { offset: 100 } });

      expect(result.results.get('t1')).toBe(105);
    });
  });

  describe('execute - dependencies', () => {
    it('should respect task dependencies', async () => {
      const executionOrder: string[] = [];
      const role = createTestRole('ordered');
      const worker = createWorker(role, async (task) => {
        executionOrder.push(task.id);
        return task.input;
      });

      const coordinator = createCoordinator({ maxConcurrentTasks: 1 })
        .registerWorker(worker)
        .addTask({ id: 't1', description: 'First', input: 1 })
        .addTask({ id: 't2', description: 'Second', input: 2, dependencies: ['t1'] })
        .addTask({ id: 't3', description: 'Third', input: 3, dependencies: ['t2'] });

      await coordinator.execute();

      expect(executionOrder).toEqual(['t1', 't2', 't3']);
    });

    it('should block task until dependencies complete', async () => {
      const role = createTestRole('dep-test');
      const worker = createWorker(role, async (task, context) => {
        if (task.id === 't2') {
          const t1Result = context.getTaskResult('t1');
          return (t1Result as number) * 2;
        }
        return task.input;
      });

      const coordinator = createCoordinator()
        .registerWorker(worker)
        .addTask({ id: 't1', description: 'First', input: 5 })
        .addTask({ id: 't2', description: 'Second', input: 0, dependencies: ['t1'] });

      const result = await coordinator.execute();

      expect(result.results.get('t2')).toBe(10);
    });
  });

  describe('execute - concurrency', () => {
    it('should respect maxConcurrentTasks', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const role = createTestRole('concurrent');
      const worker = createWorker(role, async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((r) => setTimeout(r, 50));
        currentConcurrent--;
        return true;
      });

      const coordinator = createCoordinator({ maxConcurrentTasks: 2 })
        .registerWorker(worker)
        .addTasks([
          { id: 't1', description: 'Task 1', input: 1 },
          { id: 't2', description: 'Task 2', input: 2 },
          { id: 't3', description: 'Task 3', input: 3 },
          { id: 't4', description: 'Task 4', input: 4 },
        ]);

      await coordinator.execute();

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });
  });

  describe('execute - hooks', () => {
    it('should call onTaskStart hook', async () => {
      const startedTasks: string[] = [];
      const role = createTestRole('hooked');
      const worker = createTestWorker(role);

      const coordinator = createCoordinator({
        onTaskStart: (task) => startedTasks.push(task.id),
      })
        .registerWorker(worker)
        .addTask({ id: 't1', description: 'Task', input: 1 });

      await coordinator.execute();

      expect(startedTasks).toContain('t1');
    });

    it('should call onTaskComplete hook', async () => {
      const completedTasks: { id: string; result: unknown }[] = [];
      const role = createTestRole('hooked');
      const worker = createWorker(role, async (task) => task.input);

      const coordinator = createCoordinator({
        onTaskComplete: (task, result) =>
          completedTasks.push({ id: task.id, result }),
      })
        .registerWorker(worker)
        .addTask({ id: 't1', description: 'Task', input: 42 });

      await coordinator.execute();

      expect(completedTasks[0]).toEqual({ id: 't1', result: 42 });
    });

    it('should call onTaskFail hook', async () => {
      const failedTasks: { id: string; error: string }[] = [];
      const role = createTestRole('failer');
      const worker = createWorker(role, async () => {
        throw new Error('Oops');
      });

      const coordinator = createCoordinator({
        onTaskFail: (task, error) =>
          failedTasks.push({ id: task.id, error: error.message }),
      })
        .registerWorker(worker)
        .addTask({ id: 't1', description: 'Fail', input: null });

      await coordinator.execute();

      expect(failedTasks[0]).toEqual({ id: 't1', error: 'Oops' });
    });
  });

  describe('messaging', () => {
    it('should send messages between agents', async () => {
      const receivedMessages: string[] = [];

      const sender = createWorker(
        createTestRole('sender'),
        async (task, context) => {
          context.sendMessage({
            from: 'sender',
            to: 'receiver',
            type: 'notification',
            content: 'Hello from sender',
          });
          return 'sent';
        }
      );

      const receiver = createWorker(
        createTestRole('receiver'),
        async () => 'received',
        async (message) => {
          receivedMessages.push(message.content as string);
        }
      );

      const coordinator = createCoordinator()
        .registerWorker(sender)
        .registerWorker(receiver)
        .addTask({
          id: 't1',
          description: 'Send message',
          input: null,
          assignedRole: 'sender',
        });

      await coordinator.execute();

      expect(receivedMessages).toContain('Hello from sender');
    });

    it('should track message history', async () => {
      const worker = createWorker(
        createTestRole('messenger'),
        async (task, context) => {
          context.sendMessage({
            from: 'messenger',
            to: 'broadcast',
            type: 'notification',
            content: 'Broadcast message',
          });
          return 'done';
        }
      );

      const coordinator = createCoordinator()
        .registerWorker(worker)
        .addTask({ id: 't1', description: 'Message', input: null });

      const result = await coordinator.execute();

      expect(result.messages).toHaveLength(1);
      expect(result.stats.totalMessages).toBe(1);
    });
  });

  describe('coordination strategies', () => {
    describe('roundRobinStrategy', () => {
      it('should distribute tasks evenly', async () => {
        const taskAssignments: string[] = [];

        const worker1 = createWorker(
          createTestRole('w1', ['process']),
          async (task) => {
            taskAssignments.push('w1');
            return task.input;
          }
        );

        const worker2 = createWorker(
          createTestRole('w2', ['process']),
          async (task) => {
            taskAssignments.push('w2');
            return task.input;
          }
        );

        const coordinator = createCoordinator({
          strategy: roundRobinStrategy,
          maxConcurrentTasks: 1,
        })
          .registerWorker(worker1)
          .registerWorker(worker2)
          .addTasks([
            { id: 't1', description: 'Process task', input: 1 },
            { id: 't2', description: 'Process task', input: 2 },
            { id: 't3', description: 'Process task', input: 3 },
            { id: 't4', description: 'Process task', input: 4 },
          ]);

        await coordinator.execute();

        expect(taskAssignments).toHaveLength(4);
        const w1Count = taskAssignments.filter((id) => id === 'w1').length;
        const w2Count = taskAssignments.filter((id) => id === 'w2').length;
        expect(w1Count).toBe(2);
        expect(w2Count).toBe(2);
        expect(taskAssignments).toEqual(['w1', 'w2', 'w1', 'w2']);

        const tasks = coordinator.getTasks();
        for (const task of tasks) {
          expect(task.assignedWorkerId).toBeDefined();
          // Role preference must remain unset when not provided by the caller
          expect(task.assignedRole).toBeUndefined();
        }
      });

      it('should balance by assignedWorkerId while preserving assignedRole preference', async () => {
        const taskAssignments: string[] = [];

        // Two workers that share the same capable role filter via capability matching
        // (no assignedRole preference) — already covered above. Here we assert that an
        // explicit assignedRole preference is not overwritten when the worker runs.
        const worker = createWorker(
          createTestRole('specific', ['process']),
          async (task) => {
            taskAssignments.push(task.assignedWorkerId ?? 'unknown');
            return task.assignedRole;
          }
        );

        const coordinator = createCoordinator({
          strategy: roundRobinStrategy,
          maxConcurrentTasks: 1,
        })
          .registerWorker(worker)
          .registerWorker(
            createWorker(createTestRole('other', ['other']), async () => 'other')
          )
          .addTask({
            id: 't1',
            description: 'Process task',
            input: null,
            assignedRole: 'specific',
          });

        const result = await coordinator.execute();

        expect(result.results.get('t1')).toBe('specific');
        expect(coordinator.getTask('t1')?.assignedRole).toBe('specific');
        expect(coordinator.getTask('t1')?.assignedWorkerId).toBe('specific');
        expect(taskAssignments).toEqual(['specific']);
      });
    });

    describe('capabilityStrategy', () => {
      it('should assign tasks based on capabilities', async () => {
        const mathWorker = createWorker(
          createTestRole('math', ['math', 'calculate']),
          async (task) => (task.input as number) * 2
        );

        const textWorker = createWorker(
          createTestRole('text', ['text', 'format']),
          async (task) => (task.input as string).toUpperCase()
        );

        const coordinator = createCoordinator({
          strategy: capabilityStrategy,
        })
          .registerWorker(mathWorker)
          .registerWorker(textWorker)
          .addTasks([
            { id: 't1', description: 'Calculate math result', input: 5 },
            { id: 't2', description: 'Format text output', input: 'hello' },
          ]);

        const result = await coordinator.execute();

        expect(result.results.get('t1')).toBe(10);
        expect(result.results.get('t2')).toBe('HELLO');
      });
    });
  });

  describe('task assignment', () => {
    it('should respect explicit assignedRole', async () => {
      const worker1 = createWorker(
        createTestRole('specific'),
        async () => 'from specific'
      );

      const worker2 = createWorker(
        createTestRole('generic'),
        async () => 'from generic'
      );

      const coordinator = createCoordinator()
        .registerWorker(worker1)
        .registerWorker(worker2)
        .addTask({
          id: 't1',
          description: 'Task',
          input: null,
          assignedRole: 'specific',
        });

      const result = await coordinator.execute();

      expect(result.results.get('t1')).toBe('from specific');
    });
  });

  describe('clear', () => {
    it('should clear all state', async () => {
      const coordinator = createCoordinator()
        .registerWorker(createTestWorker(createTestRole('w')))
        .addTask({ id: 't1', description: 'Task', input: 1 });

      await coordinator.execute();

      coordinator.clear();

      expect(coordinator.getTasks()).toHaveLength(0);
      expect(coordinator.getMessages()).toHaveLength(0);
    });
  });

  describe('SupervisorWorkerPattern', () => {
    it('should coordinate supervisor and workers', async () => {
      const supervisorRole = createTestRole('supervisor', ['coordinate']);
      const pattern = new SupervisorWorkerPattern(
        supervisorRole,
        async (task) => `Supervised: ${task.input}`
      );

      const workerRole = createTestRole('worker', ['execute']);
      pattern.addWorker(createWorker(workerRole, async (task) => `Worked: ${task.input}`));

      pattern.addTask({
        id: 't1',
        description: 'Coordinate task',
        input: 'data',
        assignedRole: 'supervisor',
      });

      const result = await pattern.execute();

      expect(result.success).toBe(true);
      expect(result.results.get('t1')).toBe('Supervised: data');
    });
  });

  describe('PipelinePattern', () => {
    it('should process through pipeline stages', async () => {
      const pattern = new PipelinePattern();

      pattern.addStage(
        createWorker(createTestRole('stage1'), async (task, context) => {
          const input = task.input ?? context.shared['lastOutput'];
          context.shared['lastOutput'] = (input as number) + 10;
          return context.shared['lastOutput'];
        })
      );

      pattern.addStage(
        createWorker(createTestRole('stage2'), async (task, context) => {
          const input = context.shared['lastOutput'] as number;
          context.shared['lastOutput'] = input * 2;
          return context.shared['lastOutput'];
        })
      );

      const result = await pattern.execute(5);

      expect(result.success).toBe(true);
      // Stage 1: 5 + 10 = 15
      // Stage 2: 15 * 2 = 30
      expect(result.results.get('stage-1')).toBe(30);
    });
  });

  describe('DebatePattern', () => {
    it('should conduct debate rounds', async () => {
      const pattern = new DebatePattern({ maxRounds: 2 });

      pattern.addDebater(
        createWorker(createTestRole('debater1'), async (task) => {
          const ctx = task.input as { round: number };
          return `Debater 1 argument for round ${ctx.round + 1}`;
        })
      );

      pattern.addDebater(
        createWorker(createTestRole('debater2'), async (task) => {
          const ctx = task.input as { round: number };
          return `Debater 2 argument for round ${ctx.round + 1}`;
        })
      );

      pattern.setJudge(
        createWorker(createTestRole('judge'), async () => 'Verdict: Draw')
      );

      const result = await pattern.debate('Test topic');

      expect(result.rounds).toHaveLength(2);
      expect(result.rounds[0]).toHaveLength(2);
      expect(result.verdict).toBe('Verdict: Draw');
    });

    it('should work without judge', async () => {
      const pattern = new DebatePattern({ maxRounds: 1 });

      pattern.addDebater(
        createWorker(createTestRole('solo'), async () => 'Solo argument')
      );

      const result = await pattern.debate('Solo debate');

      expect(result.rounds).toHaveLength(1);
      expect(result.verdict).toBeNull();
    });
  });

  describe('statistics', () => {
    it('should provide execution statistics', async () => {
      const worker = createTestWorker(createTestRole('stats'));

      const coordinator = createCoordinator()
        .registerWorker(worker)
        .addTasks([
          { id: 't1', description: 'Task 1', input: 1 },
          { id: 't2', description: 'Task 2', input: 2 },
        ]);

      const result = await coordinator.execute();

      expect(result.stats.totalTasks).toBe(2);
      expect(result.stats.completedTasks).toBe(2);
      expect(result.stats.failedTasks).toBe(0);
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
