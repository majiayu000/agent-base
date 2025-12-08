// ============================================================================
// Human-in-the-Loop Pattern - Human intervention and approval points
// ============================================================================

export interface ApprovalRequest {
  /** Request ID */
  id: string;
  /** Type of approval needed */
  type: 'action' | 'output' | 'decision' | 'custom';
  /** Description of what needs approval */
  description: string;
  /** The content/action to approve */
  content: unknown;
  /** Additional context */
  context?: Record<string, unknown>;
  /** Timestamp */
  createdAt: Date;
  /** Timeout in ms (0 = no timeout) */
  timeoutMs: number;
  /** Priority level */
  priority: 'low' | 'medium' | 'high' | 'critical';
}

export interface ApprovalResponse {
  /** Request ID */
  requestId: string;
  /** Whether approved */
  approved: boolean;
  /** Optional modified content */
  modifiedContent?: unknown;
  /** Human feedback/reason */
  feedback?: string;
  /** Who approved */
  approver?: string;
  /** Response timestamp */
  respondedAt: Date;
}

export interface HITLConfig {
  /** Default timeout for approval requests in ms (default: 300000 = 5 min) */
  defaultTimeoutMs: number;
  /** Auto-approve low priority requests (default: false) */
  autoApproveLowPriority: boolean;
  /** Handler for approval requests */
  approvalHandler?: (request: ApprovalRequest) => Promise<ApprovalResponse>;
  /** Handler for notifications */
  notifyHandler?: (message: string, priority: ApprovalRequest['priority']) => void;
}

export interface HITLResult {
  /** The approval request */
  request: ApprovalRequest;
  /** The response (if any) */
  response?: ApprovalResponse;
  /** Whether timed out */
  timedOut: boolean;
  /** Whether auto-approved */
  autoApproved: boolean;
  /** Processing time in ms */
  processingTimeMs: number;
}

/**
 * Human-in-the-Loop manager
 */
export class HumanInTheLoop {
  private config: HITLConfig;
  private pendingRequests: Map<string, ApprovalRequest> = new Map();
  private resolvers: Map<string, (response: ApprovalResponse) => void> = new Map();
  private history: HITLResult[] = [];

  constructor(config?: Partial<HITLConfig>) {
    this.config = {
      defaultTimeoutMs: config?.defaultTimeoutMs ?? 300000,
      autoApproveLowPriority: config?.autoApproveLowPriority ?? false,
      approvalHandler: config?.approvalHandler,
      notifyHandler: config?.notifyHandler,
    };
  }

  /**
   * Request human approval
   */
  async requestApproval(options: {
    type: ApprovalRequest['type'];
    description: string;
    content: unknown;
    context?: Record<string, unknown>;
    priority?: ApprovalRequest['priority'];
    timeoutMs?: number;
  }): Promise<HITLResult> {
    const startTime = Date.now();
    const request: ApprovalRequest = {
      id: crypto.randomUUID(),
      type: options.type,
      description: options.description,
      content: options.content,
      context: options.context,
      createdAt: new Date(),
      timeoutMs: options.timeoutMs ?? this.config.defaultTimeoutMs,
      priority: options.priority ?? 'medium',
    };

    // Check for auto-approve
    if (this.config.autoApproveLowPriority && request.priority === 'low') {
      const result: HITLResult = {
        request,
        response: {
          requestId: request.id,
          approved: true,
          feedback: 'Auto-approved (low priority)',
          respondedAt: new Date(),
        },
        timedOut: false,
        autoApproved: true,
        processingTimeMs: Date.now() - startTime,
      };
      this.history.push(result);
      return result;
    }

    this.pendingRequests.set(request.id, request);

    // Notify
    this.config.notifyHandler?.(
      `Approval needed: ${request.description}`,
      request.priority
    );

    try {
      // If we have a handler, use it
      if (this.config.approvalHandler) {
        const response = await Promise.race([
          this.config.approvalHandler(request),
          this.createTimeout(request.timeoutMs, request.id),
        ]);

        const result: HITLResult = {
          request,
          response: response as ApprovalResponse,
          timedOut: false,
          autoApproved: false,
          processingTimeMs: Date.now() - startTime,
        };

        this.pendingRequests.delete(request.id);
        this.history.push(result);
        return result;
      }

      // Wait for external approval via respond()
      const response = await Promise.race([
        new Promise<ApprovalResponse>((resolve) => {
          this.resolvers.set(request.id, resolve);
        }),
        this.createTimeout(request.timeoutMs, request.id),
      ]);

      const result: HITLResult = {
        request,
        response: response as ApprovalResponse,
        timedOut: false,
        autoApproved: false,
        processingTimeMs: Date.now() - startTime,
      };

      this.pendingRequests.delete(request.id);
      this.resolvers.delete(request.id);
      this.history.push(result);
      return result;

    } catch (error) {
      // Timeout
      const result: HITLResult = {
        request,
        timedOut: true,
        autoApproved: false,
        processingTimeMs: Date.now() - startTime,
      };

      this.pendingRequests.delete(request.id);
      this.resolvers.delete(request.id);
      this.history.push(result);
      return result;
    }
  }

  /**
   * Create a timeout promise
   */
  private createTimeout(ms: number, requestId: string): Promise<never> {
    if (ms === 0) {
      return new Promise(() => {}); // Never resolves
    }
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Approval timeout for ${requestId}`)), ms);
    });
  }

  /**
   * Respond to a pending request (for external approval flows)
   */
  respond(response: ApprovalResponse): boolean {
    const resolver = this.resolvers.get(response.requestId);
    if (resolver) {
      resolver(response);
      return true;
    }
    return false;
  }

  /**
   * Approve a pending request (convenience method)
   */
  approve(requestId: string, options?: { feedback?: string; approver?: string; modifiedContent?: unknown }): boolean {
    return this.respond({
      requestId,
      approved: true,
      feedback: options?.feedback,
      approver: options?.approver,
      modifiedContent: options?.modifiedContent,
      respondedAt: new Date(),
    });
  }

  /**
   * Reject a pending request (convenience method)
   */
  reject(requestId: string, options?: { feedback?: string; approver?: string }): boolean {
    return this.respond({
      requestId,
      approved: false,
      feedback: options?.feedback,
      approver: options?.approver,
      respondedAt: new Date(),
    });
  }

  /**
   * Get pending requests
   */
  getPendingRequests(): ApprovalRequest[] {
    return Array.from(this.pendingRequests.values());
  }

  /**
   * Get a specific pending request
   */
  getPendingRequest(id: string): ApprovalRequest | undefined {
    return this.pendingRequests.get(id);
  }

  /**
   * Cancel a pending request
   */
  cancelRequest(id: string): boolean {
    const request = this.pendingRequests.get(id);
    if (request) {
      this.pendingRequests.delete(id);
      const resolver = this.resolvers.get(id);
      if (resolver) {
        this.resolvers.delete(id);
      }
      return true;
    }
    return false;
  }

  /**
   * Get approval history
   */
  getHistory(): HITLResult[] {
    return [...this.history];
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalRequests: number;
    approved: number;
    rejected: number;
    timedOut: number;
    autoApproved: number;
    pending: number;
    averageResponseTimeMs: number;
  } {
    let approved = 0;
    let rejected = 0;
    let timedOut = 0;
    let autoApproved = 0;
    let totalResponseTime = 0;
    let respondedCount = 0;

    for (const result of this.history) {
      if (result.timedOut) {
        timedOut++;
      } else if (result.autoApproved) {
        autoApproved++;
      } else if (result.response?.approved) {
        approved++;
        totalResponseTime += result.processingTimeMs;
        respondedCount++;
      } else {
        rejected++;
        totalResponseTime += result.processingTimeMs;
        respondedCount++;
      }
    }

    return {
      totalRequests: this.history.length,
      approved,
      rejected,
      timedOut,
      autoApproved,
      pending: this.pendingRequests.size,
      averageResponseTimeMs: respondedCount > 0 ? totalResponseTime / respondedCount : 0,
    };
  }

  /**
   * Clear history
   */
  clearHistory(): void {
    this.history = [];
  }
}

/**
 * Create a Human-in-the-Loop manager
 */
export function createHITL(config?: Partial<HITLConfig>): HumanInTheLoop {
  return new HumanInTheLoop(config);
}

/**
 * Decorator for requiring approval on a function
 */
export function requireApproval(
  hitl: HumanInTheLoop,
  options: {
    description: string;
    priority?: ApprovalRequest['priority'];
  }
) {
  return function <T extends (...args: unknown[]) => Promise<unknown>>(
    target: T
  ): T {
    return (async (...args: unknown[]) => {
      const result = await hitl.requestApproval({
        type: 'action',
        description: options.description,
        content: { function: target.name, args },
        priority: options.priority,
      });

      if (result.timedOut) {
        throw new Error('Approval request timed out');
      }

      if (!result.response?.approved) {
        throw new Error(`Action rejected: ${result.response?.feedback || 'No reason provided'}`);
      }

      return target(...args);
    }) as T;
  };
}
