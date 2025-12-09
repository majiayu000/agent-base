import { describe, it, expect, beforeEach } from 'bun:test';
import {
  KnowledgeBase,
  createKnowledgeBase,
  HybridRetriever,
  createHybridRetriever,
  Reranker,
  createReranker,
} from '../src/patterns/rag.js';

describe('RAG Pattern', () => {
  let kb: KnowledgeBase;

  beforeEach(() => {
    kb = createKnowledgeBase({
      chunkSize: 200,
      chunkOverlap: 20,
      topK: 3,
      minScore: 0.01,
    });
  });

  describe('createKnowledgeBase', () => {
    it('should create knowledge base with default config', () => {
      const k = createKnowledgeBase();
      expect(k).toBeInstanceOf(KnowledgeBase);
    });

    it('should create knowledge base with custom config', () => {
      const k = createKnowledgeBase({
        chunkSize: 1000,
        topK: 10,
      });
      expect(k).toBeInstanceOf(KnowledgeBase);
    });
  });

  describe('addDocument', () => {
    it('should add a document', async () => {
      const doc = await kb.addDocument({
        content: 'TypeScript is a programming language developed by Microsoft.',
        metadata: { source: 'wiki' },
      });

      expect(doc.id).toBeDefined();
      expect(doc.content).toContain('TypeScript');
      expect(doc.metadata?.source).toBe('wiki');
    });

    it('should add document with custom id', async () => {
      const doc = await kb.addDocument({
        id: 'custom-id',
        content: 'Test content',
      });

      expect(doc.id).toBe('custom-id');
    });

    it('should add multiple documents', async () => {
      const docs = await kb.addDocuments([
        { content: 'Document 1 about JavaScript' },
        { content: 'Document 2 about Python' },
        { content: 'Document 3 about Rust' },
      ]);

      expect(docs).toHaveLength(3);
      expect(kb.getStats().documentCount).toBe(3);
    });
  });

  describe('chunking', () => {
    it('should chunk long documents', async () => {
      const longContent = 'This is a test sentence. '.repeat(50);
      await kb.addDocument({ content: longContent });

      const stats = kb.getStats();
      expect(stats.chunkCount).toBeGreaterThan(1);
    });

    it('should create chunks with overlap', async () => {
      const doc = await kb.addDocument({
        id: 'test-doc',
        content: 'First paragraph with important information. Second paragraph continues the topic. Third paragraph concludes.',
      });

      const chunks = kb.getDocumentChunks('test-doc');
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0].documentId).toBe('test-doc');
    });
  });

  describe('retrieve', () => {
    beforeEach(async () => {
      await kb.addDocuments([
        { content: 'TypeScript adds static typing to JavaScript. It compiles to plain JavaScript.' },
        { content: 'Python is known for its simple syntax and readability.' },
        { content: 'Rust provides memory safety without garbage collection.' },
        { content: 'JavaScript is the language of the web browsers.' },
      ]);
    });

    it('should retrieve relevant chunks', async () => {
      const results = await kb.retrieve('TypeScript programming');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].chunk.content.toLowerCase()).toContain('typescript');
    });

    it('should respect topK parameter', async () => {
      const results = await kb.retrieve('programming language', { topK: 2 });

      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('should respect minScore parameter', async () => {
      const results = await kb.retrieve('completely unrelated query xyz123', { minScore: 0.5 });

      // Should return empty or low score results
      expect(results.every((r) => r.score >= 0.5 || results.length === 0)).toBe(true);
    });

    it('should return scores', async () => {
      const results = await kb.retrieve('JavaScript web');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].score).toBeGreaterThan(0);
      expect(results[0].score).toBeLessThanOrEqual(1);
    });

    it('should sort by relevance', async () => {
      const results = await kb.retrieve('TypeScript');

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });
  });

  describe('buildContext', () => {
    beforeEach(async () => {
      await kb.addDocuments([
        { content: 'AI agents can use tools to perform tasks.', metadata: { source: 'guide' } },
        { content: 'LLMs are the backbone of modern AI agents.', metadata: { source: 'paper' } },
      ]);
    });

    it('should build context from retrieved chunks', async () => {
      const context = await kb.buildContext('AI agents');

      expect(context.context).toContain('AI');
      expect(context.chunks.length).toBeGreaterThan(0);
      expect(context.query).toBe('AI agents');
      expect(context.totalDocuments).toBe(2);
      expect(context.retrievalTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should include source information', async () => {
      const context = await kb.buildContext('LLMs');

      expect(context.context).toContain('Source:');
    });
  });

  describe('augmentPrompt', () => {
    beforeEach(async () => {
      await kb.addDocument({
        content: 'The capital of France is Paris. Paris is known for the Eiffel Tower.',
      });
    });

    it('should generate augmented prompt', async () => {
      const prompt = await kb.augmentPrompt('What is the capital of France?');

      expect(prompt).toContain('capital of France');
      expect(prompt).toContain('Paris');
      expect(prompt).toContain('Context:');
    });

    it('should use custom template', async () => {
      const template = 'Based on: {context}\n\nAnswer: {query}';
      const prompt = await kb.augmentPrompt('What is the capital?', template);

      expect(prompt).toContain('Based on:');
      expect(prompt).toContain('Answer:');
    });
  });

  describe('document management', () => {
    it('should get document by ID', async () => {
      await kb.addDocument({ id: 'doc1', content: 'Test document' });

      const doc = kb.getDocument('doc1');
      expect(doc).toBeDefined();
      expect(doc?.content).toBe('Test document');
    });

    it('should get all documents', async () => {
      await kb.addDocuments([
        { content: 'Doc 1' },
        { content: 'Doc 2' },
      ]);

      const docs = kb.getAllDocuments();
      expect(docs).toHaveLength(2);
    });

    it('should remove document and its chunks', async () => {
      await kb.addDocument({ id: 'to-remove', content: 'This will be removed' });

      const removed = kb.removeDocument('to-remove');
      expect(removed).toBe(true);
      expect(kb.getDocument('to-remove')).toBeUndefined();
      expect(kb.getDocumentChunks('to-remove')).toHaveLength(0);
    });

    it('should return false when removing non-existent document', () => {
      const removed = kb.removeDocument('non-existent');
      expect(removed).toBe(false);
    });

    it('should clear all data', async () => {
      await kb.addDocuments([{ content: 'Doc 1' }, { content: 'Doc 2' }]);

      kb.clear();

      expect(kb.getStats().documentCount).toBe(0);
      expect(kb.getStats().chunkCount).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return statistics', async () => {
      await kb.addDocuments([
        { content: 'Short doc' },
        { content: 'A longer document with more content for testing purposes' },
      ]);

      const stats = kb.getStats();

      expect(stats.documentCount).toBe(2);
      expect(stats.chunkCount).toBeGreaterThanOrEqual(2);
      expect(stats.averageChunkSize).toBeGreaterThan(0);
    });
  });

  describe('export/import', () => {
    it('should export and import knowledge base', async () => {
      await kb.addDocuments([
        { content: 'Document about AI' },
        { content: 'Document about ML' },
      ]);

      const exported = kb.export();
      expect(exported).toContain('Document about AI');

      kb.clear();
      expect(kb.getStats().documentCount).toBe(0);

      kb.import(exported);
      expect(kb.getStats().documentCount).toBe(2);
    });
  });

  describe('HybridRetriever', () => {
    it('should create hybrid retriever', () => {
      const retriever = createHybridRetriever();
      expect(retriever).toBeInstanceOf(HybridRetriever);
    });

    it('should combine results from multiple retrievers', async () => {
      const kb1 = createKnowledgeBase();
      const kb2 = createKnowledgeBase();

      await kb1.addDocument({ content: 'TypeScript is great for large projects' });
      await kb2.addDocument({ content: 'TypeScript has strong typing' });

      const hybrid = createHybridRetriever()
        .addRetriever('kb1', (q) => kb1.retrieve(q), 1.0)
        .addRetriever('kb2', (q) => kb2.retrieve(q), 0.8);

      const results = await hybrid.retrieve('TypeScript', 5);

      expect(results.length).toBeGreaterThan(0);
    });

    it('should weight results appropriately', async () => {
      const kb1 = createKnowledgeBase({ minScore: 0.01 });
      await kb1.addDocument({ content: 'Test content' });

      const hybrid = createHybridRetriever()
        .addRetriever('weighted', (q) => kb1.retrieve(q), 0.5);

      const results = await hybrid.retrieve('Test', 5);

      // Scores should be multiplied by weight
      if (results.length > 0) {
        expect(results[0].score).toBeLessThanOrEqual(0.5);
      }
    });
  });

  describe('Reranker', () => {
    it('should create reranker', () => {
      const reranker = createReranker(async () => 0.5);
      expect(reranker).toBeInstanceOf(Reranker);
    });

    it('should rerank results', async () => {
      await kb.addDocuments([
        { content: 'First document' },
        { content: 'Second document' },
      ]);

      const results = await kb.retrieve('document');

      const reranker = createReranker(async (query, content) => {
        // Simple reranking: prefer "Second"
        return content.includes('Second') ? 1.0 : 0.5;
      });

      const reranked = await reranker.rerank('document', results);

      expect(reranked[0].chunk.content).toContain('Second');
    });

    it('should respect topK in reranking', async () => {
      await kb.addDocuments([
        { content: 'Doc 1' },
        { content: 'Doc 2' },
        { content: 'Doc 3' },
      ]);

      const results = await kb.retrieve('Doc');

      const reranker = createReranker(async () => Math.random());
      const reranked = await reranker.rerank('Doc', results, 1);

      expect(reranked).toHaveLength(1);
    });
  });

  describe('with embeddings', () => {
    it('should use custom embedder', async () => {
      let embedderCalled = false;

      const kbWithEmbedder = createKnowledgeBase({
        embedder: async (text) => {
          embedderCalled = true;
          // Simple hash-based embedding for testing
          const hash = text.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
          return [hash % 100 / 100, (hash * 2) % 100 / 100];
        },
      });

      await kbWithEmbedder.addDocument({ content: 'Test document' });

      expect(embedderCalled).toBe(true);
      expect(kbWithEmbedder.getStats().hasEmbeddings).toBe(true);
    });
  });
});
