/**
 * Minimal ambient types for `mammoth` (it ships no .d.ts). We only use
 * extractRawText for DOCX → plain text during KB ingestion.
 */
declare module 'mammoth' {
  interface MammothMessage {
    type: string;
    message: string;
  }
  interface MammothResult {
    value: string;
    messages: MammothMessage[];
  }
  interface MammothInput {
    buffer?: Buffer;
    arrayBuffer?: ArrayBuffer;
    path?: string;
  }
  export function extractRawText(input: MammothInput): Promise<MammothResult>;
  export function convertToHtml(input: MammothInput): Promise<MammothResult>;
}
