import { describe, it, expect, beforeEach } from 'bun:test';
import {
  HumanInTheLoop,
  createHITL,
  requireApproval,
} from '../src/patterns/human-in-the-loop.js';
import type { ApprovalRequest, ApprovalResponse } from '../src/patterns/human-in-the-loop.js';

describe('Human-in-the-Loop Pattern', () => {
  let hitl: HumanInTheLoop;

  beforeEach(() => {
    hitl = createHITL();
  });

  describe('createHITL', () => {
    it('should create HITL with default config', () => {
      const h = createHITL();
      expect(h).toBeInstanceOf(HumanInTheLoop);
    });

    it('should create HITL with custom config', () => {
      const h = createHITL({
        defaultTimeoutMs: 60000,
        autoApproveLowPriority: true,
      });
      expect(h).toBeInstanceOf(HumanInTheLoop);
    });
  });

  describe('requestApproval with handler', () => {
    it('should request approval and get response via handler', async () => {
      const h = createHITL({
        approvalHandler: async (request: ApprovalRequest) => ({
          requestId: request.id,
          approved: true,
          feedback: 'Looks good',
          approver: 'test-user',
          respondedAt: new Date(),
        }),
      });

      const result = await h.requestApproval({
        type: 'action',
        description: 'Delete user data',
        content: { action: 'delete', userId: '123' },
        priority: 'high',
      });

      expect(result.timedOut).toBe(false);
      expect(result.autoApproved).toBe(false);
      expect(result.response?.approved).toBe(true);
      expect(result.response?.feedback).toBe('Looks good');
    });

    it('should handle rejection via handler', async () => {
      const h = createHITL({
        approvalHandler: async (request: ApprovalRequest) => ({
          requestId: request.id,
          approved: false,
          feedback: 'Too risky',
          respondedAt: new Date(),
        }),
      });

      const result = await h.requestApproval({
        type: 'decision',
        description: 'Deploy to production',
        content: { environment: 'prod' },
      });

      expect(result.response?.approved).toBe(false);
      expect(result.response?.feedback).toBe('Too risky');
    });
  });

  describe('auto-approve low priority', () => {
    it('should auto-approve low priority requests when enabled', async () => {
      const h = createHITL({
        autoApproveLowPriority: true,
      });

      const result = await h.requestApproval({
        type: 'action',
        description: 'Log message',
        content: { message: 'info' },
        priority: 'low',
      });

      expect(result.autoApproved).toBe(true);
      expect(result.response?.approved).toBe(true);
      expect(result.response?.feedback).toBe('Auto-approved (low priority)');
    });

    it('should not auto-approve non-low priority', async () => {
      const h = createHITL({
        autoApproveLowPriority: true,
        approvalHandler: async (request: ApprovalRequest) => ({
          requestId: request.id,
          approved: true,
          respondedAt: new Date(),
        }),
      });

      const result = await h.requestApproval({
        type: 'action',
        description: 'Important action',
        content: {},
        priority: 'medium',
      });

      expect(result.autoApproved).toBe(false);
    });
  });

  describe('respond/approve/reject', () => {
    it('should respond to pending request', async () => {
      const resultPromise = hitl.requestApproval({
        type: 'action',
        description: 'Test action',
        content: {},
        timeoutMs: 5000,
      });

      // Wait a bit for request to be registered
      await new Promise((r) => setTimeout(r, 10));

      const pending = hitl.getPendingRequests();
      expect(pending.length).toBe(1);

      const success = hitl.respond({
        requestId: pending[0].id,
        approved: true,
        feedback: 'Approved via respond',
        respondedAt: new Date(),
      });

      expect(success).toBe(true);

      const result = await resultPromise;
      expect(result.response?.approved).toBe(true);
    });

    it('should approve pending request via convenience method', async () => {
      const resultPromise = hitl.requestApproval({
        type: 'output',
        description: 'Review output',
        content: 'Some output text',
        timeoutMs: 5000,
      });

      await new Promise((r) => setTimeout(r, 10));

      const pending = hitl.getPendingRequests();
      const success = hitl.approve(pending[0].id, {
        feedback: 'Output looks good',
        approver: 'reviewer',
      });

      expect(success).toBe(true);

      const result = await resultPromise;
      expect(result.response?.approved).toBe(true);
      expect(result.response?.approver).toBe('reviewer');
    });

    it('should reject pending request via convenience method', async () => {
      const resultPromise = hitl.requestApproval({
        type: 'decision',
        description: 'Make decision',
        content: {},
        timeoutMs: 5000,
      });

      await new Promise((r) => setTimeout(r, 10));

      const pending = hitl.getPendingRequests();
      hitl.reject(pending[0].id, {
        feedback: 'Not now',
      });

      const result = await resultPromise;
      expect(result.response?.approved).toBe(false);
      expect(result.response?.feedback).toBe('Not now');
    });

    it('should return false when responding to non-existent request', () => {
      const success = hitl.approve('non-existent-id');
      expect(success).toBe(false);
    });
  });

  describe('timeout handling', () => {
    it('should timeout after specified duration', async () => {
      const result = await hitl.requestApproval({
        type: 'action',
        description: 'Time-sensitive action',
        content: {},
        timeoutMs: 50,
      });

      expect(result.timedOut).toBe(true);
      expect(result.response).toBeUndefined();
    });

    it('should not timeout when timeoutMs is 0', async () => {
      const h = createHITL({
        approvalHandler: async (request: ApprovalRequest) => {
          await new Promise((r) => setTimeout(r, 100));
          return {
            requestId: request.id,
            approved: true,
            respondedAt: new Date(),
          };
        },
      });

      const result = await h.requestApproval({
        type: 'action',
        description: 'No timeout action',
        content: {},
        timeoutMs: 0,
      });

      expect(result.timedOut).toBe(false);
      expect(result.response?.approved).toBe(true);
    });
  });

  describe('pending requests management', () => {
    it('should get pending request by id', async () => {
      const resultPromise = hitl.requestApproval({
        type: 'action',
        description: 'Test',
        content: {},
        timeoutMs: 5000,
      });

      await new Promise((r) => setTimeout(r, 10));

      const pending = hitl.getPendingRequests();
      const request = hitl.getPendingRequest(pending[0].id);

      expect(request).toBeDefined();
      expect(request?.description).toBe('Test');

      hitl.approve(pending[0].id);
      await resultPromise;
    });

    it('should cancel pending request', async () => {
      const resultPromise = hitl.requestApproval({
        type: 'action',
        description: 'Cancelable',
        content: {},
        timeoutMs: 100, // Short timeout for test
      });

      await new Promise((r) => setTimeout(r, 10));

      const pending = hitl.getPendingRequests();
      const cancelled = hitl.cancelRequest(pending[0].id);

      expect(cancelled).toBe(true);
      expect(hitl.getPendingRequests().length).toBe(0);

      // The promise will timeout since we cancelled
      const result = await resultPromise;
      expect(result.timedOut).toBe(true);
    });

    it('should return false when cancelling non-existent request', () => {
      const cancelled = hitl.cancelRequest('non-existent');
      expect(cancelled).toBe(false);
    });
  });

  describe('history and statistics', () => {
    it('should track approval history', async () => {
      const h = createHITL({
        approvalHandler: async (request: ApprovalRequest) => ({
          requestId: request.id,
          approved: true,
          respondedAt: new Date(),
        }),
      });

      await h.requestApproval({
        type: 'action',
        description: 'Action 1',
        content: {},
      });

      await h.requestApproval({
        type: 'action',
        description: 'Action 2',
        content: {},
      });

      const history = h.getHistory();
      expect(history.length).toBe(2);
    });

    it('should provide statistics', async () => {
      const h = createHITL({
        autoApproveLowPriority: true,
        approvalHandler: async (request: ApprovalRequest) => ({
          requestId: request.id,
          approved: request.description !== 'Reject this',
          respondedAt: new Date(),
        }),
      });

      // Auto-approved
      await h.requestApproval({
        type: 'action',
        description: 'Auto',
        content: {},
        priority: 'low',
      });

      // Approved via handler
      await h.requestApproval({
        type: 'action',
        description: 'Approve this',
        content: {},
        priority: 'medium',
      });

      // Rejected via handler
      await h.requestApproval({
        type: 'action',
        description: 'Reject this',
        content: {},
        priority: 'high',
      });

      const stats = h.getStats();
      expect(stats.totalRequests).toBe(3);
      expect(stats.approved).toBe(1);
      expect(stats.rejected).toBe(1);
      expect(stats.autoApproved).toBe(1);
      expect(stats.timedOut).toBe(0);
      expect(stats.pending).toBe(0);
    });

    it('should clear history', async () => {
      const h = createHITL({
        approvalHandler: async (request: ApprovalRequest) => ({
          requestId: request.id,
          approved: true,
          respondedAt: new Date(),
        }),
      });

      await h.requestApproval({
        type: 'action',
        description: 'Test',
        content: {},
      });

      expect(h.getHistory().length).toBe(1);

      h.clearHistory();
      expect(h.getHistory().length).toBe(0);
    });
  });

  describe('notification handler', () => {
    it('should call notify handler when requesting approval', async () => {
      const notifications: { message: string; priority: string }[] = [];

      const h = createHITL({
        notifyHandler: (message, priority) => {
          notifications.push({ message, priority });
        },
        approvalHandler: async (request: ApprovalRequest) => ({
          requestId: request.id,
          approved: true,
          respondedAt: new Date(),
        }),
      });

      await h.requestApproval({
        type: 'action',
        description: 'Important action',
        content: {},
        priority: 'critical',
      });

      expect(notifications.length).toBe(1);
      expect(notifications[0].message).toContain('Important action');
      expect(notifications[0].priority).toBe('critical');
    });
  });

  describe('modified content', () => {
    it('should support modified content in response', async () => {
      const h = createHITL({
        approvalHandler: async (request: ApprovalRequest) => ({
          requestId: request.id,
          approved: true,
          modifiedContent: { ...request.content as object, modified: true },
          respondedAt: new Date(),
        }),
      });

      const result = await h.requestApproval({
        type: 'output',
        description: 'Review and modify',
        content: { original: true },
      });

      expect(result.response?.modifiedContent).toEqual({
        original: true,
        modified: true,
      });
    });
  });

  describe('requireApproval decorator', () => {
    it('should wrap function with approval requirement', async () => {
      const h = createHITL({
        approvalHandler: async (request: ApprovalRequest) => ({
          requestId: request.id,
          approved: true,
          respondedAt: new Date(),
        }),
      });

      const dangerousAction = async (x: unknown, y: unknown) => {
        return `Executed with ${x} and ${y}`;
      };

      const wrapped = requireApproval(h, {
        description: 'Dangerous action',
        priority: 'high',
      })(dangerousAction);

      const result = await wrapped('arg1', 'arg2');
      expect(result).toBe('Executed with arg1 and arg2');
    });

    it('should throw when approval is rejected', async () => {
      const h = createHITL({
        approvalHandler: async (request: ApprovalRequest) => ({
          requestId: request.id,
          approved: false,
          feedback: 'Not allowed',
          respondedAt: new Date(),
        }),
      });

      const dangerousAction = async () => 'Executed';
      const wrapped = requireApproval(h, {
        description: 'Blocked action',
      })(dangerousAction);

      await expect(wrapped()).rejects.toThrow('Action rejected: Not allowed');
    });

    it('should throw when approval times out', async () => {
      const h = createHITL({
        defaultTimeoutMs: 50,
      });

      const dangerousAction = async () => 'Executed';
      const wrapped = requireApproval(h, {
        description: 'Timeout action',
      })(dangerousAction);

      await expect(wrapped()).rejects.toThrow('Approval request timed out');
    });
  });

  describe('request types', () => {
    it('should support all request types', async () => {
      const h = createHITL({
        approvalHandler: async (request: ApprovalRequest) => ({
          requestId: request.id,
          approved: true,
          respondedAt: new Date(),
        }),
      });

      const types: ApprovalRequest['type'][] = ['action', 'output', 'decision', 'custom'];

      for (const type of types) {
        const result = await h.requestApproval({
          type,
          description: `Test ${type}`,
          content: {},
        });
        expect(result.request.type).toBe(type);
      }
    });
  });

  describe('context passing', () => {
    it('should pass context to approval request', async () => {
      let receivedContext: Record<string, unknown> | undefined;

      const h = createHITL({
        approvalHandler: async (request: ApprovalRequest) => {
          receivedContext = request.context;
          return {
            requestId: request.id,
            approved: true,
            respondedAt: new Date(),
          };
        },
      });

      await h.requestApproval({
        type: 'action',
        description: 'Action with context',
        content: {},
        context: { userId: '123', role: 'admin' },
      });

      expect(receivedContext).toEqual({ userId: '123', role: 'admin' });
    });
  });
});
