import { describe, it, expect } from 'vitest';
import { chunkText, CHUNK_SIZE, CHUNK_OVERLAP } from '@/lib/kb/chunk';

describe('chunkText', () => {
  it('returns nothing for empty or whitespace-only input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\t  ')).toEqual([]);
  });

  it('returns a single trimmed chunk for short input', () => {
    expect(chunkText('  hello world  ')).toEqual(['hello world']);
  });

  it('splits long text into overlapping windows, each within the size bound', () => {
    // 50 space-separated words → comfortably exceeds CHUNK_SIZE.
    const words = Array.from({ length: 800 }, (_, i) => `word${i}`);
    const text = words.join(' ');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHUNK_SIZE);
    // Consecutive windows overlap: the tail of one chunk reappears in the next.
    const tail = chunks[0].slice(-CHUNK_OVERLAP / 2);
    expect(chunks[1].includes(tail.trim().split(' ').pop()!)).toBe(true);
  });

  it('covers the whole document (no content dropped between windows)', () => {
    const text = Array.from({ length: 500 }, (_, i) => `token${i}`).join(' ');
    const chunks = chunkText(text);
    // Every token must appear in at least one chunk.
    for (let i = 0; i < 500; i++) {
      expect(chunks.some((c) => c.includes(`token${i}`))).toBe(true);
    }
  });

  it('terminates and chunks even with no whitespace to break on', () => {
    const text = 'a'.repeat(5000);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    // Hard cut at the size boundary when there's no whitespace.
    expect(chunks[0].length).toBe(CHUNK_SIZE);
  });

  it('respects the maxChunks bound', () => {
    const text = 'a'.repeat(100_000);
    const chunks = chunkText(text, { size: 100, overlap: 10, maxChunks: 5 });
    expect(chunks).toHaveLength(5);
  });

  it('clamps overlap >= size so it still makes progress', () => {
    const text = 'a'.repeat(1000);
    const chunks = chunkText(text, { size: 100, overlap: 999 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(1000); // didn't loop forever
  });
});
