/**
 * Example 7: Human-in-the-Loop Pattern
 *
 * This example demonstrates human approval workflows
 * and intervention points using the HITL pattern.
 */

import { createHITL, requireApproval } from '../src/index.js';
import type { ApprovalRequest } from '../src/index.js';

async function main() {
  console.log('=== Basic Approval Flow ===\n');

  // Create HITL with an approval handler
  const hitl = createHITL({
    defaultTimeoutMs: 5000, // 5 second timeout for demo
    approvalHandler: async (request: ApprovalRequest) => {
      // Simulate human review
      console.log(`  [Review] ${request.description}`);
      console.log(`  [Review] Priority: ${request.priority}`);
      console.log(`  [Review] Content:`, request.content);

      // Auto-approve for demo (in real usage, this would be interactive)
      const approved = request.priority !== 'critical';
      console.log(`  [Decision] ${approved ? 'APPROVED' : 'REJECTED'}\n`);

      return {
        requestId: request.id,
        approved,
        feedback: approved ? 'Looks good!' : 'Too risky to proceed',
        approver: 'demo-user',
        respondedAt: new Date(),
      };
    },
    notifyHandler: (message, priority) => {
      console.log(`[Notification] (${priority}) ${message}`);
    },
  });

  // Request approvals for different actions
  const actions = [
    { desc: 'Send email to user', content: { to: 'user@example.com' }, priority: 'low' as const },
    { desc: 'Update database record', content: { table: 'users', id: 123 }, priority: 'medium' as const },
    { desc: 'Delete all user data', content: { action: 'purge' }, priority: 'critical' as const },
  ];

  for (const action of actions) {
    console.log(`Requesting approval: "${action.desc}"`);
    const result = await hitl.requestApproval({
      type: 'action',
      description: action.desc,
      content: action.content,
      priority: action.priority,
    });

    console.log(`Result: ${result.response?.approved ? 'Approved' : 'Rejected'}`);
    console.log(`Processing time: ${result.processingTimeMs}ms\n`);
  }

  console.log('=== Auto-Approve Low Priority ===\n');

  const autoHitl = createHITL({
    autoApproveLowPriority: true,
  });

  const lowPriorityResult = await autoHitl.requestApproval({
    type: 'action',
    description: 'Log debug message',
    content: { level: 'debug' },
    priority: 'low',
  });

  console.log('Low priority action:');
  console.log(`  Auto-approved: ${lowPriorityResult.autoApproved}`);
  console.log(`  Feedback: ${lowPriorityResult.response?.feedback}`);

  console.log('\n=== External Approval (Async) ===\n');

  const asyncHitl = createHITL({
    defaultTimeoutMs: 10000,
  });

  // Start approval request (non-blocking)
  const approvalPromise = asyncHitl.requestApproval({
    type: 'decision',
    description: 'Deploy to production',
    content: { version: '2.0.0', environment: 'prod' },
    priority: 'high',
  });

  // Simulate external approval after delay
  setTimeout(() => {
    const pending = asyncHitl.getPendingRequests();
    if (pending.length > 0) {
      console.log('External system approving...');
      asyncHitl.approve(pending[0].id, {
        feedback: 'Deployment approved by CI/CD',
        approver: 'jenkins',
      });
    }
  }, 100);

  const asyncResult = await approvalPromise;
  console.log('Async approval result:');
  console.log(`  Approved: ${asyncResult.response?.approved}`);
  console.log(`  Approver: ${asyncResult.response?.approver}`);

  console.log('\n=== Function Decorator ===\n');

  const decoratorHitl = createHITL({
    approvalHandler: async (request) => ({
      requestId: request.id,
      approved: true,
      feedback: 'Function execution approved',
      respondedAt: new Date(),
    }),
  });

  // Wrap a dangerous function with approval requirement
  const dangerousDelete = async (id: string) => {
    console.log(`  Deleting resource ${id}...`);
    return `Deleted ${id}`;
  };

  const safeDelete = requireApproval(decoratorHitl, {
    description: 'Delete resource',
    priority: 'high',
  })(dangerousDelete);

  console.log('Calling wrapped function...');
  try {
    const deleteResult = await safeDelete('resource-123');
    console.log('Result:', deleteResult);
  } catch (error) {
    console.log('Error:', (error as Error).message);
  }

  console.log('\n=== Statistics ===\n');

  const stats = hitl.getStats();
  console.log('Total requests:', stats.totalRequests);
  console.log('Approved:', stats.approved);
  console.log('Rejected:', stats.rejected);
  console.log('Timed out:', stats.timedOut);
  console.log('Auto-approved:', stats.autoApproved);
  console.log('Average response time:', stats.averageResponseTimeMs.toFixed(0), 'ms');

  console.log('\nHistory:');
  hitl.getHistory().forEach((h, i) => {
    console.log(`  ${i + 1}. ${h.request.description} - ${h.response?.approved ? 'Approved' : 'Rejected'}`);
  });
}

main().catch(console.error);
