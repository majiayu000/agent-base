// ============================================================================
// RAG Pattern - Retrieval-Augmented Generation
// ============================================================================

export interface Document {
  /** Document ID */
  id: string;
  /** Document content */
  content: string;
  /** Document metadata */
  metadata?: Record<string, unknown>;
  /** Pre-computed embedding (optional) */
  embedding?: number[];
}

export interface Chunk {
  /** Chunk ID */
  id: string;
  /** Source document ID */
  documentId: string;
  /** Chunk content */
  content: string;
  /** Chunk index in document */
  index: number;
  /** Chunk metadata */
  metadata?: Record<string, unknown>;
  /** Pre-computed embedding (optional) */
  embedding?: number[];
}

export interface RetrievalResult {
  /** Retrieved chunk */
  chunk: Chunk;
  /** Relevance score (0-1) */
  score: number;
  /** Source document */
  document?: Document;
}

export interface RAGConfig {
  /** Chunk size in characters (default: 500) */
  chunkSize: number;
  /** Chunk overlap in characters (default: 50) */
  chunkOverlap: number;
  /** Maximum results to return (default: 5) */
  topK: number;
  /** Minimum score threshold (default: 0.1) */
  minScore: number;
  /** Custom embedding function */
  embedder?: (text: string) => Promise<number[]>;
  /** Custom similarity function */
  similarityFn?: (a: number[], b: number[]) => number;
}

export interface RAGContext {
  /** Retrieved chunks */
  chunks: RetrievalResult[];
  /** Formatted context string */
  context: string;
  /** Query used */
  query: string;
  /** Total documents searched */
  totalDocuments: number;
  /** Retrieval time in ms */
  retrievalTimeMs: number;
}

/**
 * Simple text-based similarity using TF-IDF-like scoring
 */
function textSimilarity(query: string, content: string): number {
  const queryWords = new Set(
    query
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2)
  );
  const contentWords = content
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);

  if (queryWords.size === 0 || contentWords.length === 0) return 0;

  let matches = 0;
  const contentWordSet = new Set(contentWords);

  for (const word of queryWords) {
    if (contentWordSet.has(word)) {
      matches++;
    }
  }

  // TF-IDF-like score
  const tf = matches / queryWords.size;
  const idf = Math.log(1 + contentWords.length / (matches + 1));

  return tf * idf;
}

/**
 * Cosine similarity for embeddings
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

/**
 * RAG Knowledge Base
 */
export class KnowledgeBase {
  private documents: Map<string, Document> = new Map();
  private chunks: Map<string, Chunk> = new Map();
  private config: RAGConfig;

  constructor(config?: Partial<RAGConfig>) {
    this.config = {
      chunkSize: config?.chunkSize ?? 500,
      chunkOverlap: config?.chunkOverlap ?? 50,
      topK: config?.topK ?? 5,
      minScore: config?.minScore ?? 0.1,
      embedder: config?.embedder,
      similarityFn: config?.similarityFn ?? cosineSimilarity,
    };
  }

  /**
   * Add a document to the knowledge base
   */
  async addDocument(doc: Omit<Document, 'id'> & { id?: string }): Promise<Document> {
    const document: Document = {
      id: doc.id ?? crypto.randomUUID(),
      content: doc.content,
      metadata: doc.metadata,
      embedding: doc.embedding,
    };

    // Generate embedding if embedder provided and no embedding exists
    if (this.config.embedder && !document.embedding) {
      document.embedding = await this.config.embedder(document.content);
    }

    this.documents.set(document.id, document);

    // Chunk the document
    const chunks = this.chunkDocument(document);
    for (const chunk of chunks) {
      // Generate chunk embedding
      if (this.config.embedder && !chunk.embedding) {
        chunk.embedding = await this.config.embedder(chunk.content);
      }
      this.chunks.set(chunk.id, chunk);
    }

    return document;
  }

  /**
   * Add multiple documents
   */
  async addDocuments(docs: Array<Omit<Document, 'id'> & { id?: string }>): Promise<Document[]> {
    const results: Document[] = [];
    for (const doc of docs) {
      results.push(await this.addDocument(doc));
    }
    return results;
  }

  /**
   * Chunk a document into smaller pieces
   */
  private chunkDocument(doc: Document): Chunk[] {
    const chunks: Chunk[] = [];
    const content = doc.content;
    const { chunkSize, chunkOverlap } = this.config;

    let index = 0;
    let position = 0;

    while (position < content.length) {
      const end = Math.min(position + chunkSize, content.length);
      let chunkContent = content.slice(position, end);

      // Try to break at sentence boundary
      if (end < content.length) {
        const lastPeriod = chunkContent.lastIndexOf('.');
        const lastNewline = chunkContent.lastIndexOf('\n');
        const breakPoint = Math.max(lastPeriod, lastNewline);

        if (breakPoint > chunkSize * 0.5) {
          chunkContent = chunkContent.slice(0, breakPoint + 1);
        }
      }

      chunks.push({
        id: `${doc.id}-chunk-${index}`,
        documentId: doc.id,
        content: chunkContent.trim(),
        index,
        metadata: doc.metadata,
      });

      position += chunkContent.length - chunkOverlap;
      index++;

      // Safety: prevent infinite loop
      if (position <= 0) position = end;
    }

    return chunks;
  }

  /**
   * Retrieve relevant chunks for a query
   */
  async retrieve(query: string, options?: { topK?: number; minScore?: number }): Promise<RetrievalResult[]> {
    const topK = options?.topK ?? this.config.topK;
    const minScore = options?.minScore ?? this.config.minScore;

    const results: RetrievalResult[] = [];
    let queryEmbedding: number[] | undefined;

    // Generate query embedding if embedder available
    if (this.config.embedder) {
      queryEmbedding = await this.config.embedder(query);
    }

    for (const chunk of this.chunks.values()) {
      let score: number;

      if (queryEmbedding && chunk.embedding) {
        // Use embedding similarity
        score = this.config.similarityFn!(queryEmbedding, chunk.embedding);
      } else {
        // Fall back to text similarity
        score = textSimilarity(query, chunk.content);
      }

      if (score >= minScore) {
        results.push({
          chunk,
          score,
          document: this.documents.get(chunk.documentId),
        });
      }
    }

    // Sort by score and return top K
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /**
   * Build context from retrieved chunks
   */
  async buildContext(query: string, options?: { topK?: number; minScore?: number }): Promise<RAGContext> {
    const startTime = Date.now();
    const results = await this.retrieve(query, options);

    // Format context
    const contextParts = results.map((r, i) => {
      const source = r.document?.metadata?.source || r.chunk.documentId;
      return `[${i + 1}] (Source: ${source})\n${r.chunk.content}`;
    });

    return {
      chunks: results,
      context: contextParts.join('\n\n'),
      query,
      totalDocuments: this.documents.size,
      retrievalTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Generate a prompt with retrieved context
   */
  async augmentPrompt(
    query: string,
    template?: string,
    options?: { topK?: number; minScore?: number }
  ): Promise<string> {
    const context = await this.buildContext(query, options);

    const defaultTemplate = `Use the following context to answer the question. If the context doesn't contain relevant information, say so.

Context:
{context}

Question: {query}

Answer:`;

    const promptTemplate = template ?? defaultTemplate;

    return promptTemplate.replace('{context}', context.context).replace('{query}', query);
  }

  /**
   * Remove a document and its chunks
   */
  removeDocument(id: string): boolean {
    const doc = this.documents.get(id);
    if (!doc) return false;

    // Remove associated chunks
    for (const [chunkId, chunk] of this.chunks) {
      if (chunk.documentId === id) {
        this.chunks.delete(chunkId);
      }
    }

    this.documents.delete(id);
    return true;
  }

  /**
   * Get a document by ID
   */
  getDocument(id: string): Document | undefined {
    return this.documents.get(id);
  }

  /**
   * Get all documents
   */
  getAllDocuments(): Document[] {
    return Array.from(this.documents.values());
  }

  /**
   * Get chunk by ID
   */
  getChunk(id: string): Chunk | undefined {
    return this.chunks.get(id);
  }

  /**
   * Get all chunks for a document
   */
  getDocumentChunks(documentId: string): Chunk[] {
    return Array.from(this.chunks.values()).filter((c) => c.documentId === documentId);
  }

  /**
   * Clear all documents and chunks
   */
  clear(): void {
    this.documents.clear();
    this.chunks.clear();
  }

  /**
   * Get statistics
   */
  getStats(): {
    documentCount: number;
    chunkCount: number;
    averageChunkSize: number;
    hasEmbeddings: boolean;
  } {
    const chunks = Array.from(this.chunks.values());
    const totalChunkSize = chunks.reduce((sum, c) => sum + c.content.length, 0);

    return {
      documentCount: this.documents.size,
      chunkCount: this.chunks.size,
      averageChunkSize: chunks.length > 0 ? totalChunkSize / chunks.length : 0,
      hasEmbeddings: chunks.some((c) => c.embedding !== undefined),
    };
  }

  /**
   * Export knowledge base
   */
  export(): string {
    return JSON.stringify(
      {
        documents: Array.from(this.documents.values()),
        chunks: Array.from(this.chunks.values()),
        config: {
          chunkSize: this.config.chunkSize,
          chunkOverlap: this.config.chunkOverlap,
          topK: this.config.topK,
          minScore: this.config.minScore,
        },
      },
      null,
      2
    );
  }

  /**
   * Import knowledge base
   */
  import(json: string): void {
    const data = JSON.parse(json);

    this.documents.clear();
    this.chunks.clear();

    for (const doc of data.documents || []) {
      this.documents.set(doc.id, doc);
    }

    for (const chunk of data.chunks || []) {
      this.chunks.set(chunk.id, chunk);
    }
  }
}

/**
 * Create a knowledge base
 */
export function createKnowledgeBase(config?: Partial<RAGConfig>): KnowledgeBase {
  return new KnowledgeBase(config);
}

/**
 * Hybrid retriever - combines multiple retrieval strategies
 */
export class HybridRetriever {
  private retrievers: Array<{
    name: string;
    retriever: (query: string) => Promise<RetrievalResult[]>;
    weight: number;
  }> = [];

  /**
   * Add a retriever with a weight
   */
  addRetriever(
    name: string,
    retriever: (query: string) => Promise<RetrievalResult[]>,
    weight: number = 1.0
  ): this {
    this.retrievers.push({ name, retriever, weight });
    return this;
  }

  /**
   * Retrieve and merge results from all retrievers
   */
  async retrieve(query: string, topK: number = 5): Promise<RetrievalResult[]> {
    // Get results from all retrievers
    const allResults = await Promise.all(
      this.retrievers.map(async ({ retriever, weight }) => {
        const results = await retriever(query);
        return results.map((r) => ({ ...r, score: r.score * weight }));
      })
    );

    // Merge and deduplicate by chunk ID
    const merged = new Map<string, RetrievalResult>();

    for (const results of allResults) {
      for (const result of results) {
        const existing = merged.get(result.chunk.id);
        if (!existing || result.score > existing.score) {
          merged.set(result.chunk.id, result);
        }
      }
    }

    // Sort and return top K
    const sorted = Array.from(merged.values()).sort((a, b) => b.score - a.score);
    return sorted.slice(0, topK);
  }
}

/**
 * Create a hybrid retriever
 */
export function createHybridRetriever(): HybridRetriever {
  return new HybridRetriever();
}

/**
 * Reranker - reorders results using a scoring function
 */
export class Reranker {
  private scoreFn: (query: string, content: string) => Promise<number>;

  constructor(scoreFn: (query: string, content: string) => Promise<number>) {
    this.scoreFn = scoreFn;
  }

  /**
   * Rerank results
   */
  async rerank(query: string, results: RetrievalResult[], topK?: number): Promise<RetrievalResult[]> {
    const reranked = await Promise.all(
      results.map(async (result) => {
        const newScore = await this.scoreFn(query, result.chunk.content);
        return { ...result, score: newScore };
      })
    );

    reranked.sort((a, b) => b.score - a.score);
    return topK ? reranked.slice(0, topK) : reranked;
  }
}

/**
 * Create a reranker
 */
export function createReranker(
  scoreFn: (query: string, content: string) => Promise<number>
): Reranker {
  return new Reranker(scoreFn);
}
