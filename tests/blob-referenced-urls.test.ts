import { describe, it, expect } from 'vitest';
import { extractReferencedUrls } from '@/lib/files/blob';
import type { OpenAIMessage } from '@/lib/http/openai';

describe('extractReferencedUrls', () => {
  it('extracts image_url and file.file_url from message content', () => {
    const msgs: OpenAIMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'x' },
          { type: 'image_url', image_url: { url: 'https://e.com/a.png' } },
          { type: 'file', file: { file_url: 'https://e.com/b.pdf' } },
        ],
      },
    ];
    expect(extractReferencedUrls(msgs)).toEqual(['https://e.com/a.png', 'https://e.com/b.pdf']);
  });

  // Regression: the cross-key ownership check must see every URL the model mapper
  // forwards. partToModelPart resolves `file_url ?? file_data`, so a blob URL
  // smuggled through file_data must still be collected — otherwise it bypasses
  // assertOwnedBlobs and a cross-key upload could be read.
  it('also extracts a file URL carried in file_data (matches the mapper sink)', () => {
    const msgs: OpenAIMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'file', file: { file_data: 'https://x.blob.vercel-storage.com/uploads/other/secret.pdf' } },
        ],
      },
    ];
    expect(extractReferencedUrls(msgs)).toEqual([
      'https://x.blob.vercel-storage.com/uploads/other/secret.pdf',
    ]);
  });

  it('prefers file_url over file_data when both are present (mirrors the sink)', () => {
    const msgs: OpenAIMessage[] = [
      {
        role: 'user',
        content: [{ type: 'file', file: { file_url: 'https://e.com/u.pdf', file_data: 'https://e.com/d.pdf' } }],
      },
    ];
    expect(extractReferencedUrls(msgs)).toEqual(['https://e.com/u.pdf']);
  });
});
