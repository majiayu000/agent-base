/**
 * Example 4: Memory Pattern
 *
 * This example demonstrates short-term and long-term memory
 * management for agents using the Memory pattern.
 */

import { createMemoryStore } from '../src/index.js';

async function main() {
  // Create a memory store
  const memory = createMemoryStore({
    shortTermCapacity: 10, // Keep 10 items in short-term
    longTermCapacity: 100, // Keep 100 items in long-term
    longTermThreshold: 0.5, // Importance >= 0.5 goes to long-term
    autoPromote: true,
    enableDecay: true,
  });

  console.log('=== Adding Memories ===\n');

  // Add memories with varying importance
  // Low importance (< 0.5) goes to short-term
  const pref1 = memory.add('User prefers dark mode', {
    type: 'preference',
    importance: 0.3,
    tags: ['preference', 'ui'],
  });
  console.log(`Added to short-term: ${pref1.content}`);

  const pref2 = memory.add('User is a software developer', {
    type: 'fact',
    importance: 0.4,
    tags: ['profile', 'occupation'],
  });
  console.log(`Added to short-term: ${pref2.content}`);

  // High importance (>= 0.5) goes to long-term
  const fact1 = memory.add('User completed TypeScript tutorial on 2024-01-15', {
    type: 'fact',
    importance: 0.8,
    tags: ['achievement', 'typescript'],
  });
  console.log(`Added to long-term: ${fact1.content}`);

  const fact2 = memory.add('User prefers functional programming style', {
    type: 'preference',
    importance: 0.6,
    tags: ['preference', 'coding-style'],
  });
  console.log(`Added to long-term: ${fact2.content}`);

  console.log('\nStats:', memory.getStats());

  // Search memories
  console.log('\n=== Searching Memories ===\n');

  console.log('Search for "typescript":');
  const tsResults = memory.search('typescript', { limit: 5 });
  tsResults.forEach((r) => {
    console.log(`  - ${r.entry.content} (relevance: ${r.relevance.toFixed(2)})`);
  });

  console.log('\nSearch for "preference":');
  const prefResults = memory.search('preference', { limit: 5 });
  prefResults.forEach((r) => {
    console.log(`  - ${r.entry.content} (relevance: ${r.relevance.toFixed(2)})`);
  });

  console.log('\nSearch for "programming":');
  const progResults = memory.search('programming', { limit: 5 });
  progResults.forEach((r) => {
    console.log(`  - ${r.entry.content} (relevance: ${r.relevance.toFixed(2)})`);
  });

  // Promote memory to long-term
  console.log('\n=== Promoting Memory ===\n');

  console.log(`Promoting: "${pref1.content}" (id: ${pref1.id})`);
  const promoted = memory.promote(pref1.id);
  console.log(`Promoted: ${promoted}`);
  console.log('Updated stats:', memory.getStats());

  // Get specific memory
  console.log('\n=== Get Memory by ID ===\n');

  const retrieved = memory.get(fact1.id);
  if (retrieved) {
    console.log('Retrieved memory:');
    console.log(`  Content: ${retrieved.content}`);
    console.log(`  Type: ${retrieved.type}`);
    console.log(`  Importance: ${retrieved.importance}`);
    console.log(`  Tags: ${retrieved.tags.join(', ')}`);
  }

  // Export/Import memories
  console.log('\n=== Export/Import ===\n');

  const exported = memory.export();
  console.log('Exported memories (preview):');
  console.log(exported.substring(0, 200) + '...');

  // Clear and reimport
  const currentStats = memory.getStats();
  console.log('\nCurrent entries:', currentStats.totalEntries);

  memory.clear();
  console.log('After clear:', memory.getStats().totalEntries);

  memory.import(exported);
  console.log('After import:', memory.getStats().totalEntries);

  // Apply decay
  console.log('\n=== Decay Simulation ===\n');

  console.log('Before decay:');
  const beforeDecay = memory.search('user', { limit: 2 });
  beforeDecay.forEach((r) => {
    console.log(`  ${r.entry.content}: importance=${r.entry.importance.toFixed(2)}`);
  });

  memory.applyDecay();

  console.log('\nAfter decay:');
  const afterDecay = memory.search('user', { limit: 2 });
  afterDecay.forEach((r) => {
    console.log(`  ${r.entry.content}: importance=${r.entry.importance.toFixed(2)}`);
  });

  // Remove a memory
  console.log('\n=== Remove Memory ===\n');

  console.log(`Removing memory: ${pref2.id}`);
  const removed = memory.remove(pref2.id);
  console.log(`Removed: ${removed}`);
  console.log('Final stats:', memory.getStats());
}

main().catch(console.error);
