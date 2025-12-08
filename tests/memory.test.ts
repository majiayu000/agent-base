import { describe, it, expect, beforeEach } from 'bun:test';
import { MemoryStore, createMemoryStore } from '../src/patterns/memory.js';

describe('Memory Pattern', () => {
  let memory: MemoryStore;

  beforeEach(() => {
    memory = createMemoryStore();
  });

  describe('createMemoryStore', () => {
    it('should create memory store with default config', () => {
      const store = createMemoryStore();
      expect(store).toBeInstanceOf(MemoryStore);
    });

    it('should create memory store with custom config', () => {
      const store = createMemoryStore({
        shortTermCapacity: 50,
        longTermCapacity: 500,
        longTermThreshold: 0.7,
      });
      expect(store).toBeInstanceOf(MemoryStore);
    });
  });

  describe('add()', () => {
    it('should add memory entry with default values', () => {
      const entry = memory.add('Test content');
      expect(entry.id).toBeDefined();
      expect(entry.content).toBe('Test content');
      expect(entry.type).toBe('fact');
      expect(entry.importance).toBe(0.5);
    });

    it('should add memory entry with custom options', () => {
      const entry = memory.add('Custom content', {
        type: 'preference',
        importance: 0.8,
        tags: ['test', 'custom'],
        metadata: { source: 'test' },
      });
      expect(entry.type).toBe('preference');
      expect(entry.importance).toBe(0.8);
      expect(entry.tags).toContain('test');
      expect(entry.metadata?.source).toBe('test');
    });

    it('should store high importance entries in long-term', () => {
      memory.add('Important fact', { importance: 0.9 });
      const stats = memory.getStats();
      expect(stats.longTermCount).toBe(1);
      expect(stats.shortTermCount).toBe(0);
    });

    it('should store low importance entries in short-term', () => {
      memory.add('Temporary info', { importance: 0.3 });
      const stats = memory.getStats();
      expect(stats.shortTermCount).toBe(1);
      expect(stats.longTermCount).toBe(0);
    });
  });

  describe('get()', () => {
    it('should retrieve memory by ID', () => {
      const added = memory.add('Retrievable content');
      const retrieved = memory.get(added.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.content).toBe('Retrievable content');
    });

    it('should return undefined for non-existent ID', () => {
      const retrieved = memory.get('non-existent-id');
      expect(retrieved).toBeUndefined();
    });

    it('should increment access count on retrieval', () => {
      const added = memory.add('Content');
      memory.get(added.id);
      memory.get(added.id);
      const retrieved = memory.get(added.id);
      expect(retrieved?.accessCount).toBe(3);
    });
  });

  describe('search()', () => {
    beforeEach(() => {
      memory.add('The quick brown fox', { tags: ['animal'] });
      memory.add('A lazy dog sleeps', { tags: ['animal'] });
      memory.add('Programming in TypeScript', { tags: ['tech'] });
    });

    it('should find memories by keyword', () => {
      const results = memory.search('fox');
      expect(results.length).toBe(1);
      expect(results[0].entry.content).toContain('fox');
    });

    it('should return empty for no matches', () => {
      const results = memory.search('elephant');
      expect(results.length).toBe(0);
    });

    it('should filter by tags', () => {
      const results = memory.search('quick dog', { tags: ['animal'] });
      expect(results.length).toBe(2); // Both animal entries match
    });

    it('should limit results', () => {
      const results = memory.search('', { limit: 1 });
      expect(results.length).toBeLessThanOrEqual(1);
    });
  });

  describe('remove()', () => {
    it('should remove memory by ID', () => {
      const entry = memory.add('To be removed');
      const removed = memory.remove(entry.id);
      expect(removed).toBe(true);
      expect(memory.get(entry.id)).toBeUndefined();
    });

    it('should return false for non-existent ID', () => {
      const removed = memory.remove('non-existent');
      expect(removed).toBe(false);
    });
  });

  describe('clear()', () => {
    it('should clear all memories', () => {
      memory.add('Short term', { importance: 0.3 });
      memory.add('Long term', { importance: 0.8 });
      memory.clear('all');
      const stats = memory.getStats();
      expect(stats.totalEntries).toBe(0);
    });

    it('should clear only short-term', () => {
      memory.add('Short term', { importance: 0.3 });
      memory.add('Long term', { importance: 0.8 });
      memory.clear('short-term');
      const stats = memory.getStats();
      expect(stats.shortTermCount).toBe(0);
      expect(stats.longTermCount).toBe(1);
    });
  });

  describe('promote()', () => {
    it('should promote memory to long-term', () => {
      const entry = memory.add('Promotable', { importance: 0.3 });
      const statsBefore = memory.getStats();
      expect(statsBefore.shortTermCount).toBe(1);

      const promoted = memory.promote(entry.id);
      expect(promoted).toBe(true);

      const statsAfter = memory.getStats();
      expect(statsAfter.shortTermCount).toBe(0);
      expect(statsAfter.longTermCount).toBe(1);
    });
  });

  describe('getStats()', () => {
    it('should return correct statistics', () => {
      memory.add('Entry 1', { importance: 0.3 });
      memory.add('Entry 2', { importance: 0.8 });
      memory.add('Entry 3', { importance: 0.6 });

      const stats = memory.getStats();
      expect(stats.totalEntries).toBe(3);
      expect(stats.averageImportance).toBeCloseTo(0.567, 1);
    });
  });

  describe('export/import', () => {
    it('should export and import memories', () => {
      memory.add('Memory 1', { importance: 0.3 });
      memory.add('Memory 2', { importance: 0.8 });

      const exported = memory.export();
      expect(exported).toContain('Memory 1');
      expect(exported).toContain('Memory 2');

      const newMemory = createMemoryStore();
      newMemory.import(exported);
      const stats = newMemory.getStats();
      expect(stats.totalEntries).toBe(2);
    });
  });
});
