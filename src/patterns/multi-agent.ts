// ============================================================================
// Multi-Agent Pattern - Coordinated agent collaboration
// ============================================================================

export interface AgentRole {
  /** Role identifier */
  id: string;
  /** Role name */
  name: string;
  /** Role description */
  description: string;
  /** System prompt for this role */
  systemPrompt: string;
  /** Capabilities this role can perform */
  capabilities: string[];
  /** Maximum concurrent tasks */
  maxConcurrentTasks?: number;
}

export interface AgentTask {
  /** Task identifier */
  id: string;
  /** Task description */
  description: string;
  /** Input for the task */
  input: unknown;
  /** Preferred agent role (filter for assignment; not overwritten by load balancing) */
  assignedRole?: string;
  /** Worker id that was selected to run the task */
  assignedWorkerId?: string;
  /** Task dependencies (other task IDs) */
  dependencies?: string[];
  /** Priority (higher = more important) */
  priority?: number;
  /** Task status */
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** Task output */
  output?: unknown;
  /** Error if failed */
  error?: Error;
  /** Start time */
  startedAt?: Date;
  /** End time */
  completedAt?: Date;
}

export interface AgentMessage {
  /** Message ID */
  id: string;
  /** Sender role ID */
  from: string;
  /** Recipient role ID (or 'broadcast' for all) */
  to: string;
  /** Message type */
  type: 'request' | 'response' | 'notification' | 'delegation';
  /** Message content */
  content: unknown;
  /** Related task ID */
  taskId?: string;
  /** Timestamp */
  timestamp: Date;
}

export interface AgentWorker {
  /** Worker role */
  role: AgentRole;
  /** Execute a task */
  execute: (task: AgentTask, context: MultiAgentContext) => Promise<unknown>;
  /** Handle incoming message */
  onMessage?: (message: AgentMessage, context: MultiAgentContext) => Promise<void>;
}

export interface MultiAgentContext {
  /** All registered roles */
  roles: Map<string, AgentRole>;
  /** All workers */
  workers: Map<string, AgentWorker>;
  /** Task queue */
  tasks: Map<string, AgentTask>;
  /** Message history */
  messages: AgentMessage[];
  /** Shared state between agents */
  shared: Record<string, unknown>;
  /** Send message to another agent */
  sendMessage: (message: Omit<AgentMessage, 'id' | 'timestamp'>) => void;
  /** Get completed task results */
  getTaskResult: (taskId: string) => unknown;
  /** Coordinator reference */
  coordinator: MultiAgentCoordinator;
}

export interface CoordinationStrategy {
  /** Strategy name */
  name: string;
  /** Assign task to a role */
  assignTask: (task: AgentTask, context: MultiAgentContext) => string | null;
  /** Prioritize tasks */
  prioritizeTasks: (tasks: AgentTask[], context: MultiAgentContext) => AgentTask[];
  /** Determine if task can start (dependencies met) */
  canStartTask: (task: AgentTask, context: MultiAgentContext) => boolean;
}

export interface MultiAgentConfig {
  /** Maximum concurrent tasks across all agents */
  maxConcurrentTasks: number;
  /** Default task timeout in ms */
  defaultTaskTimeoutMs: number;
  /** Coordination strategy */
  strategy: CoordinationStrategy;
  /** Hook called when task starts */
  onTaskStart?: (task: AgentTask, worker: AgentWorker) => void;
  /** Hook called when task completes */
  onTaskComplete?: (task: AgentTask, result: unknown) => void;
  /** Hook called when task fails */
  onTaskFail?: (task: AgentTask, error: Error) => void;
  /** Hook called on message sent */
  onMessage?: (message: AgentMessage) => void;
}

export interface MultiAgentResult {
  /** Whether all tasks completed successfully */
  success: boolean;
  /** Results by task ID */
  results: Map<string, unknown>;
  /** Failed tasks */
  failures: Array<{ task: AgentTask; error: Error }>;
  /** Total execution time */
  totalDurationMs: number;
  /** Message history */
  messages: AgentMessage[];
  /** Statistics */
  stats: {
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    totalMessages: number;
  };
}

// ============================================================================
// Built-in Coordination Strategies
// ============================================================================

/**
 * Round-robin assignment strategy
 */
export const roundRobinStrategy: CoordinationStrategy = {
  name: 'round-robin',
  assignTask: (task, context) => {
    // Find capable workers
    const capableWorkers = Array.from(context.workers.entries())
      .filter(([_, worker]) => {
        if (task.assignedRole) {
          return worker.role.id === task.assignedRole;
        }
        // Check if worker has any matching capability
        const taskDesc = task.description.toLowerCase();
        return worker.role.capabilities.some((cap) =>
          taskDesc.includes(cap.toLowerCase())
        );
      })
      .map(([id]) => id);

    if (capableWorkers.length === 0) {
      // Fall back to first available worker
      const firstWorker = context.workers.keys().next().value;
      return firstWorker ?? null;
    }

    // Round-robin selection based on completed task count per worker
    const taskCounts = new Map<string, number>();
    for (const [, t] of context.tasks) {
      if (t.status === 'completed' && t.assignedWorkerId) {
        taskCounts.set(
          t.assignedWorkerId,
          (taskCounts.get(t.assignedWorkerId) || 0) + 1
        );
      }
    }

    // Select worker with fewest completed tasks
    let minCount = Infinity;
    let selectedWorker = capableWorkers[0];
    for (const workerId of capableWorkers) {
      const count = taskCounts.get(workerId) || 0;
      if (count < minCount) {
        minCount = count;
        selectedWorker = workerId;
      }
    }

    return selectedWorker;
  },
  prioritizeTasks: (tasks) => {
    return [...tasks].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  },
  canStartTask: (task, context) => {
    if (!task.dependencies || task.dependencies.length === 0) {
      return true;
    }
    return task.dependencies.every((depId) => {
      const dep = context.tasks.get(depId);
      return dep?.status === 'completed';
    });
  },
};

/**
 * Capability-based assignment strategy
 */
export const capabilityStrategy: CoordinationStrategy = {
  name: 'capability',
  assignTask: (task, context) => {
    if (task.assignedRole) {
      return task.assignedRole;
    }

    // Score each worker based on capability match
    const taskDesc = task.description.toLowerCase();
    let bestWorker: string | null = null;
    let bestScore = 0;

    for (const [id, worker] of context.workers) {
      let score = 0;
      for (const cap of worker.role.capabilities) {
        if (taskDesc.includes(cap.toLowerCase())) {
          score++;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestWorker = id;
      }
    }

    return bestWorker || context.workers.keys().next().value || null;
  },
  prioritizeTasks: (tasks) => {
    return [...tasks].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  },
  canStartTask: (task, context) => {
    if (!task.dependencies || task.dependencies.length === 0) {
      return true;
    }
    return task.dependencies.every((depId) => {
      const dep = context.tasks.get(depId);
      return dep?.status === 'completed';
    });
  },
};

// ============================================================================
// Multi-Agent Coordinator
// ============================================================================

/**
 * Multi-Agent Coordinator - orchestrates multiple agents
 */
export class MultiAgentCoordinator {
  private config: MultiAgentConfig;
  private roles: Map<string, AgentRole> = new Map();
  private workers: Map<string, AgentWorker> = new Map();
  private tasks: Map<string, AgentTask> = new Map();
  private messages: AgentMessage[] = [];
  private shared: Record<string, unknown> = {};
  private runningTasks: Set<string> = new Set();

  constructor(config?: Partial<MultiAgentConfig>) {
    this.config = {
      maxConcurrentTasks: config?.maxConcurrentTasks ?? 5,
      defaultTaskTimeoutMs: config?.defaultTaskTimeoutMs ?? 60000,
      strategy: config?.strategy ?? roundRobinStrategy,
      onTaskStart: config?.onTaskStart,
      onTaskComplete: config?.onTaskComplete,
      onTaskFail: config?.onTaskFail,
      onMessage: config?.onMessage,
    };
  }

  /**
   * Register a role
   */
  registerRole(role: AgentRole): this {
    this.roles.set(role.id, role);
    return this;
  }

  /**
   * Register a worker
   */
  registerWorker(worker: AgentWorker): this {
    this.workers.set(worker.role.id, worker);
    if (!this.roles.has(worker.role.id)) {
      this.roles.set(worker.role.id, worker.role);
    }
    return this;
  }

  /**
   * Add a task
   */
  addTask(task: Omit<AgentTask, 'status'>): this {
    const fullTask: AgentTask = {
      ...task,
      status: 'pending',
    };
    this.tasks.set(task.id, fullTask);
    return this;
  }

  /**
   * Add multiple tasks
   */
  addTasks(tasks: Array<Omit<AgentTask, 'status'>>): this {
    for (const task of tasks) {
      this.addTask(task);
    }
    return this;
  }

  /**
   * Create context for agents
   */
  private createContext(): MultiAgentContext {
    return {
      roles: this.roles,
      workers: this.workers,
      tasks: this.tasks,
      messages: this.messages,
      shared: this.shared,
      sendMessage: (msg) => this.sendMessage(msg),
      getTaskResult: (taskId) => this.tasks.get(taskId)?.output,
      coordinator: this,
    };
  }

  /**
   * Send a message between agents
   */
  private sendMessage(msg: Omit<AgentMessage, 'id' | 'timestamp'>): void {
    const message: AgentMessage = {
      ...msg,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    };
    this.messages.push(message);
    this.config.onMessage?.(message);

    // Deliver to recipient(s)
    if (msg.to === 'broadcast') {
      for (const worker of this.workers.values()) {
        worker.onMessage?.(message, this.createContext());
      }
    } else {
      const worker = this.workers.get(msg.to);
      worker?.onMessage?.(message, this.createContext());
    }
  }

  /**
   * Execute all tasks
   */
  async execute(options?: {
    shared?: Record<string, unknown>;
  }): Promise<MultiAgentResult> {
    const startTime = Date.now();
    this.shared = options?.shared ?? {};
    this.runningTasks.clear();

    const failures: Array<{ task: AgentTask; error: Error }> = [];

    // Process tasks until all are done
    while (this.hasPendingTasks()) {
      const availableTasks = this.getAvailableTasks();

      if (availableTasks.length === 0) {
        // Wait for running tasks to complete
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }

      // Start tasks up to concurrency limit
      const slotsAvailable = this.config.maxConcurrentTasks - this.runningTasks.size;
      const tasksToStart = availableTasks.slice(0, slotsAvailable);

      for (const task of tasksToStart) {
        this.executeTask(task).catch((error) => {
          failures.push({ task, error: error instanceof Error ? error : new Error(String(error)) });
        });
      }

      // Small delay to prevent tight loop
      await new Promise((r) => setTimeout(r, 10));
    }

    // Wait for all running tasks to complete
    while (this.runningTasks.size > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Collect results
    const results = new Map<string, unknown>();
    for (const [id, task] of this.tasks) {
      if (task.status === 'completed') {
        results.set(id, task.output);
      } else if (task.status === 'failed' && task.error) {
        failures.push({ task, error: task.error });
      }
    }

    return {
      success: failures.length === 0,
      results,
      failures,
      totalDurationMs: Date.now() - startTime,
      messages: [...this.messages],
      stats: {
        totalTasks: this.tasks.size,
        completedTasks: Array.from(this.tasks.values()).filter((t) => t.status === 'completed').length,
        failedTasks: failures.length,
        totalMessages: this.messages.length,
      },
    };
  }

  /**
   * Execute a single task
   */
  private async executeTask(task: AgentTask): Promise<void> {
    const context = this.createContext();

    // Assign worker
    const workerId = this.config.strategy.assignTask(task, context);
    if (!workerId) {
      task.status = 'failed';
      task.error = new Error('No worker available for task');
      return;
    }

    const worker = this.workers.get(workerId);
    if (!worker) {
      task.status = 'failed';
      task.error = new Error(`Worker ${workerId} not found`);
      return;
    }

    task.assignedWorkerId = workerId;
    task.status = 'in_progress';
    task.startedAt = new Date();
    this.runningTasks.add(task.id);

    this.config.onTaskStart?.(task, worker);

    try {
      // Execute with timeout
      const output = await Promise.race([
        worker.execute(task, context),
        new Promise((_, reject) => {
          setTimeout(
            () => reject(new Error(`Task ${task.id} timed out`)),
            this.config.defaultTaskTimeoutMs
          );
        }),
      ]);

      task.status = 'completed';
      task.output = output;
      task.completedAt = new Date();

      this.config.onTaskComplete?.(task, output);
    } catch (error) {
      task.status = 'failed';
      task.error = error instanceof Error ? error : new Error(String(error));
      task.completedAt = new Date();

      this.config.onTaskFail?.(task, task.error);
    } finally {
      this.runningTasks.delete(task.id);
    }
  }

  /**
   * Check if there are pending tasks
   */
  private hasPendingTasks(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === 'pending') {
        return true;
      }
    }
    return false;
  }

  /**
   * Get tasks that can be started
   */
  private getAvailableTasks(): AgentTask[] {
    const context = this.createContext();
    const pending = Array.from(this.tasks.values())
      .filter((t) => t.status === 'pending')
      .filter((t) => this.config.strategy.canStartTask(t, context));

    return this.config.strategy.prioritizeTasks(pending, context);
  }

  /**
   * Get all tasks
   */
  getTasks(): AgentTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get task by ID
   */
  getTask(id: string): AgentTask | undefined {
    return this.tasks.get(id);
  }

  /**
   * Get all workers
   */
  getWorkers(): AgentWorker[] {
    return Array.from(this.workers.values());
  }

  /**
   * Get message history
   */
  getMessages(): AgentMessage[] {
    return [...this.messages];
  }

  /**
   * Clear all state
   */
  clear(): void {
    this.tasks.clear();
    this.messages = [];
    this.shared = {};
    this.runningTasks.clear();
  }
}

/**
 * Create a multi-agent coordinator
 */
export function createCoordinator(config?: Partial<MultiAgentConfig>): MultiAgentCoordinator {
  return new MultiAgentCoordinator(config);
}

/**
 * Create a simple worker
 */
export function createWorker(
  role: AgentRole,
  execute: (task: AgentTask, context: MultiAgentContext) => Promise<unknown>,
  onMessage?: (message: AgentMessage, context: MultiAgentContext) => Promise<void>
): AgentWorker {
  return { role, execute, onMessage };
}

/**
 * Create a role
 */
export function createRole(
  id: string,
  name: string,
  options: {
    description: string;
    systemPrompt: string;
    capabilities: string[];
    maxConcurrentTasks?: number;
  }
): AgentRole {
  return {
    id,
    name,
    ...options,
  };
}

// ============================================================================
// Specialized Multi-Agent Patterns
// ============================================================================

/**
 * Supervisor-Worker pattern
 */
export class SupervisorWorkerPattern {
  private coordinator: MultiAgentCoordinator;
  private supervisorRole: AgentRole;

  constructor(
    supervisorRole: AgentRole,
    supervisorExecute: (task: AgentTask, context: MultiAgentContext) => Promise<unknown>,
    config?: Partial<MultiAgentConfig>
  ) {
    this.supervisorRole = supervisorRole;
    this.coordinator = createCoordinator(config);
    this.coordinator.registerWorker(createWorker(supervisorRole, supervisorExecute));
  }

  addWorker(worker: AgentWorker): this {
    this.coordinator.registerWorker(worker);
    return this;
  }

  addTask(task: Omit<AgentTask, 'status'>): this {
    this.coordinator.addTask(task);
    return this;
  }

  async execute(options?: { shared?: Record<string, unknown> }): Promise<MultiAgentResult> {
    return this.coordinator.execute(options);
  }
}

/**
 * Pipeline pattern - agents process in sequence
 */
export class PipelinePattern {
  private stages: AgentWorker[] = [];
  private coordinator: MultiAgentCoordinator;

  constructor(config?: Partial<MultiAgentConfig>) {
    this.coordinator = createCoordinator({
      ...config,
      maxConcurrentTasks: 1, // Sequential processing
    });
  }

  addStage(worker: AgentWorker): this {
    this.stages.push(worker);
    this.coordinator.registerWorker(worker);
    return this;
  }

  async execute(input: unknown): Promise<MultiAgentResult> {
    // Create tasks for each stage with dependencies
    let previousTaskId: string | undefined;

    for (let i = 0; i < this.stages.length; i++) {
      const stage = this.stages[i];
      const taskId = `stage-${i}`;

      this.coordinator.addTask({
        id: taskId,
        description: `Pipeline stage: ${stage.role.name}`,
        input: i === 0 ? input : undefined,
        assignedRole: stage.role.id,
        dependencies: previousTaskId ? [previousTaskId] : [],
      });

      previousTaskId = taskId;
    }

    return this.coordinator.execute();
  }
}

/**
 * Debate pattern - multiple agents debate to reach consensus
 */
export class DebatePattern {
  private debaters: AgentWorker[] = [];
  private judge: AgentWorker | null = null;
  private maxRounds: number;

  constructor(options: { maxRounds?: number } = {}) {
    this.maxRounds = options.maxRounds ?? 3;
  }

  addDebater(worker: AgentWorker): this {
    this.debaters.push(worker);
    return this;
  }

  setJudge(worker: AgentWorker): this {
    this.judge = worker;
    return this;
  }

  async debate(topic: string): Promise<{
    rounds: Array<{ debater: string; argument: unknown }[]>;
    verdict: unknown;
  }> {
    const rounds: Array<{ debater: string; argument: unknown }[]> = [];
    const coordinator = createCoordinator();

    // Register all participants
    for (const debater of this.debaters) {
      coordinator.registerWorker(debater);
    }

    // Conduct debate rounds
    for (let round = 0; round < this.maxRounds; round++) {
      const roundArguments: { debater: string; argument: unknown }[] = [];

      // Each debater presents argument
      for (const debater of this.debaters) {
        const context = {
          topic,
          round,
          previousRounds: rounds,
        };

        const task: AgentTask = {
          id: `debate-${round}-${debater.role.id}`,
          description: `Debate round ${round + 1}`,
          input: context,
          status: 'pending',
        };

        const argument = await debater.execute(task, {
          roles: new Map(),
          workers: new Map(),
          tasks: new Map(),
          messages: [],
          shared: {},
          sendMessage: () => {},
          getTaskResult: () => undefined,
          coordinator,
        });

        roundArguments.push({
          debater: debater.role.id,
          argument,
        });
      }

      rounds.push(roundArguments);
    }

    // Judge renders verdict
    let verdict: unknown = null;
    if (this.judge) {
      const judgeTask: AgentTask = {
        id: 'judge-verdict',
        description: 'Render verdict',
        input: { topic, rounds },
        status: 'pending',
      };

      verdict = await this.judge.execute(judgeTask, {
        roles: new Map(),
        workers: new Map(),
        tasks: new Map(),
        messages: [],
        shared: {},
        sendMessage: () => {},
        getTaskResult: () => undefined,
        coordinator,
      });
    }

    return { rounds, verdict };
  }
}
