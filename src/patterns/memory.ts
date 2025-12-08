// ============================================================================
// Memory Pattern - Short-term and Long-term memory system
// ============================================================================

export interface MemoryEntry {
  /** Unique ID */
  id: string;
  /** Memory content */
  content: string;
  /** Memory type */
  type: 'fact' | 'conversation' | 'task' | 'preference' | 'custom';
  /** Importance score (0-1) */
  importance: number;
  /** Creation timestamp */
  createdAt: Date;
  /** Last accessed timestamp */
  accessedAt: Date;
  /** Access count */
  accessCount: number;
  /** Tags for categorization */
  tags: string[];
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  relevance: number;
}

export interface MemoryConfig {
  /** Maximum entries in short-term memory (default: 100) */
  shortTermCapacity: number;
  /** Maximum entries in long-term memory (default: 1000) */
  longTermCapacity: number;
  /** Importance threshold for long-term storage (default: 0.5) */
  longTermThreshold: number;
  /** Enable automatic promotion to long-term (default: true) */
  autoPromote: boolean;
  /** Enable automatic decay of importance (default: true) */
  enableDecay: boolean;
  /** Decay rate per day (default: 0.1) */
  decayRate: number;
}

export interface MemoryStats {
  shortTermCount: number;
  longTermCount: number;
  totalEntries: number;
  oldestEntry?: Date;
  newestEntry?: Date;
  averageImportance: number;
}

/**
 * Memory Store - manages short-term and long-term memory
 */
export class MemoryStore {
  private shortTerm: Map<string, MemoryEntry> = new Map();
  private longTerm: Map<string, MemoryEntry> = new Map();
  private config: MemoryConfig;

  constructor(config?: Partial<MemoryConfig>) {
    this.config = {
      shortTermCapacity: config?.shortTermCapacity ?? 100,
      longTermCapacity: config?.longTermCapacity ?? 1000,
      longTermThreshold: config?.longTermThreshold ?? 0.5,
      autoPromote: config?.autoPromote ?? true,
      enableDecay: config?.enableDecay ?? true,
      decayRate: config?.decayRate ?? 0.1,
    };
  }

  /**
   * Add a memory entry
   */
  add(
    content: string,
    options?: {
      type?: MemoryEntry['type'];
      importance?: number;
      tags?: string[];
      metadata?: Record<string, unknown>;
    }
  ): MemoryEntry {
    const entry: MemoryEntry = {
      id: crypto.randomUUID(),
      content,
      type: options?.type ?? 'fact',
      importance: options?.importance ?? 0.5,
      createdAt: new Date(),
      accessedAt: new Date(),
      accessCount: 0,
      tags: options?.tags ?? [],
      metadata: options?.metadata,
    };

    // Determine storage location based on importance
    if (entry.importance >= this.config.longTermThreshold) {
      this.addToLongTerm(entry);
    } else {
      this.addToShortTerm(entry);
    }

    return entry;
  }

  /**
   * Add to short-term memory with capacity management
   */
  private addToShortTerm(entry: MemoryEntry): void {
    // Evict oldest if at capacity
    if (this.shortTerm.size >= this.config.shortTermCapacity) {
      this.evictOldest(this.shortTerm);
    }
    this.shortTerm.set(entry.id, entry);
  }

  /**
   * Add to long-term memory with capacity management
   */
  private addToLongTerm(entry: MemoryEntry): void {
    // Evict least important if at capacity
    if (this.longTerm.size >= this.config.longTermCapacity) {
      this.evictLeastImportant(this.longTerm);
    }
    this.longTerm.set(entry.id, entry);
  }

  /**
   * Evict oldest entry from a store
   */
  private evictOldest(store: Map<string, MemoryEntry>): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [id, entry] of store) {
      const time = entry.accessedAt.getTime();
      if (time < oldestTime) {
        oldestTime = time;
        oldestId = id;
      }
    }

    if (oldestId) {
      store.delete(oldestId);
    }
  }

  /**
   * Evict least important entry from a store
   */
  private evictLeastImportant(store: Map<string, MemoryEntry>): void {
    let leastImportantId: string | null = null;
    let lowestImportance = Infinity;

    for (const [id, entry] of store) {
      if (entry.importance < lowestImportance) {
        lowestImportance = entry.importance;
        leastImportantId = id;
      }
    }

    if (leastImportantId) {
      store.delete(leastImportantId);
    }
  }

  /**
   * Retrieve a memory by ID
   */
  get(id: string): MemoryEntry | undefined {
    let entry = this.shortTerm.get(id) || this.longTerm.get(id);

    if (entry) {
      entry.accessedAt = new Date();
      entry.accessCount++;

      // Auto-promote to long-term if accessed frequently
      if (
        this.config.autoPromote &&
        this.shortTerm.has(id) &&
        entry.accessCount >= 3
      ) {
        this.promote(id);
      }
    }

    return entry;
  }

  /**
   * Search memories by content (simple keyword matching)
   */
  search(query: string, options?: { limit?: number; type?: MemoryEntry['type']; tags?: string[] }): MemorySearchResult[] {
    const results: MemorySearchResult[] = [];
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/);

    const searchStore = (store: Map<string, MemoryEntry>) => {
      for (const entry of store.values()) {
        // Filter by type if specified
        if (options?.type && entry.type !== options.type) continue;

        // Filter by tags if specified
        if (options?.tags && !options.tags.some((tag) => entry.tags.includes(tag))) continue;

        // Calculate relevance based on keyword matches
        const contentLower = entry.content.toLowerCase();
        let matches = 0;

        for (const word of queryWords) {
          if (contentLower.includes(word)) matches++;
        }

        if (matches > 0) {
          const relevance = (matches / queryWords.length) * entry.importance;
          results.push({ entry, relevance });

          // Update access time
          entry.accessedAt = new Date();
          entry.accessCount++;
        }
      }
    };

    searchStore(this.longTerm); // Search long-term first (higher priority)
    searchStore(this.shortTerm);

    // Sort by relevance and limit
    results.sort((a, b) => b.relevance - a.relevance);

    return options?.limit ? results.slice(0, options.limit) : results;
  }

  /**
   * Promote a memory from short-term to long-term
   */
  promote(id: string): boolean {
    const entry = this.shortTerm.get(id);
    if (!entry) return false;

    this.shortTerm.delete(id);
    entry.importance = Math.min(1, entry.importance + 0.2); // Boost importance
    this.addToLongTerm(entry);

    return true;
  }

  /**
   * Remove a memory
   */
  remove(id: string): boolean {
    return this.shortTerm.delete(id) || this.longTerm.delete(id);
  }

  /**
   * Clear all memories
   */
  clear(scope?: 'short-term' | 'long-term' | 'all'): void {
    if (scope === 'short-term' || scope === 'all' || !scope) {
      this.shortTerm.clear();
    }
    if (scope === 'long-term' || scope === 'all' || !scope) {
      this.longTerm.clear();
    }
  }

  /**
   * Get memory statistics
   */
  getStats(): MemoryStats {
    const allEntries = [...this.shortTerm.values(), ...this.longTerm.values()];

    let totalImportance = 0;
    let oldestEntry: Date | undefined;
    let newestEntry: Date | undefined;

    for (const entry of allEntries) {
      totalImportance += entry.importance;

      if (!oldestEntry || entry.createdAt < oldestEntry) {
        oldestEntry = entry.createdAt;
      }
      if (!newestEntry || entry.createdAt > newestEntry) {
        newestEntry = entry.createdAt;
      }
    }

    return {
      shortTermCount: this.shortTerm.size,
      longTermCount: this.longTerm.size,
      totalEntries: allEntries.length,
      oldestEntry,
      newestEntry,
      averageImportance: allEntries.length > 0 ? totalImportance / allEntries.length : 0,
    };
  }

  /**
   * Apply decay to all memories (reduces importance over time)
   */
  applyDecay(): void {
    if (!this.config.enableDecay) return;

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    const decayStore = (store: Map<string, MemoryEntry>) => {
      for (const entry of store.values()) {
        const daysSinceAccess = (now - entry.accessedAt.getTime()) / dayMs;
        const decay = this.config.decayRate * daysSinceAccess;
        entry.importance = Math.max(0.1, entry.importance - decay);
      }
    };

    decayStore(this.shortTerm);
    decayStore(this.longTerm);
  }

  /**
   * Export memories to JSON
   */
  export(): string {
    return JSON.stringify({
      shortTerm: Array.from(this.shortTerm.values()),
      longTerm: Array.from(this.longTerm.values()),
      config: this.config,
    }, null, 2);
  }

  /**
   * Import memories from JSON
   */
  import(json: string): void {
    const data = JSON.parse(json);

    this.shortTerm.clear();
    this.longTerm.clear();

    for (const entry of data.shortTerm || []) {
      entry.createdAt = new Date(entry.createdAt);
      entry.accessedAt = new Date(entry.accessedAt);
      this.shortTerm.set(entry.id, entry);
    }

    for (const entry of data.longTerm || []) {
      entry.createdAt = new Date(entry.createdAt);
      entry.accessedAt = new Date(entry.accessedAt);
      this.longTerm.set(entry.id, entry);
    }
  }
}

/**
 * Create a memory store
 */
export function createMemoryStore(config?: Partial<MemoryConfig>): MemoryStore {
  return new MemoryStore(config);
}
