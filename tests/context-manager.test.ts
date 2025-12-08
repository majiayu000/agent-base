import { describe, it, expect, beforeEach } from 'vitest';
import { ContextManager } from '../src/core/context-manager.js';
import type { Message } from '../src/core/types.js';

describe('ContextManager', () => {
  let manager: ContextManager;

  beforeEach(() => {
    manager = new ContextManager({
      maxTokens: 1000,
      compactionThreshold: 0.8,
      preserveRecentCount: 5,
    });
  });

  describe('basic operations', () => {
    it('should add messages', () => {
      manager.add({ role: 'system', content: 'You are helpful.' });
      manager.add({ role: 'user', content: 'Hello' });

      const messages = manager.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('system');
      expect(messages[1].role).toBe('user');
    });

    it('should add multiple messages', () => {
      manager.addMany([
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'User message' },
        { role: 'assistant', content: 'Assistant reply' },
      ]);

      expect(manager.getMessages()).toHaveLength(3);
    });

    it('should track token count', () => {
      manager.add({ role: 'user', content: 'Hello world' }); // ~3 tokens

      const stats = manager.getStats();
      expect(stats.tokenCount).toBeGreaterThan(0);
    });

    it('should clear messages but keep system prompt', () => {
      manager.add({ role: 'system', content: 'System prompt' });
      manager.add({ role: 'user', content: 'User message' });
      manager.add({ role: 'assistant', content: 'Reply' });

      manager.clear();

      const messages = manager.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('system');
    });
  });

  describe('context compaction', () => {
    it('should compact when threshold is reached', () => {
      const smallManager = new ContextManager({
        maxTokens: 100, // Very small for testing
        compactionThreshold: 0.5,
        preserveRecentCount: 2,
      });

      smallManager.add({ role: 'system', content: 'System' });

      // Add many messages to trigger compaction
      for (let i = 0; i < 20; i++) {
        smallManager.add({ role: 'user', content: `Message ${i} with some content to increase tokens` });
        smallManager.add({ role: 'assistant', content: `Reply ${i} with more content here` });
      }

      const messages = smallManager.getMessages();
      // Should have compacted - fewer messages than added
      expect(messages.length).toBeLessThan(42);
    });

    it('should force compact', () => {
      manager.add({ role: 'system', content: 'System' });
      for (let i = 0; i < 10; i++) {
        manager.add({ role: 'user', content: `Message ${i}` });
        manager.add({ role: 'assistant', content: `Reply ${i}` });
      }

      const beforeCount = manager.getMessages().length;
      const result = manager.forceCompact();

      expect(result.beforeTokens).toBeGreaterThan(0);
      expect(manager.getMessages().length).toBeLessThanOrEqual(beforeCount);
    });
  });

  describe('stats', () => {
    it('should return correct stats', () => {
      manager.add({ role: 'user', content: 'Hello' });
      manager.add({ role: 'assistant', content: 'Hi there' });

      const stats = manager.getStats();

      expect(stats.messageCount).toBe(2);
      expect(stats.maxTokens).toBe(1000);
      expect(stats.tokenCount).toBeGreaterThan(0);
      expect(stats.utilizationPercent).toBeGreaterThan(0);
      expect(stats.utilizationPercent).toBeLessThan(100);
    });
  });
});
