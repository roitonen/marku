export type BlockKind = 'line' | 'emptyLine' | 'codeBlock' | 'list' | 'table';

export interface Block {
  id: number;
  markdown: string;
  html: string;
  kind: BlockKind;
}

export interface FileContent {
  path: string;
  content: string;
}

// Disk signature of a file (from the `file_signature` command), used to detect
// external changes before overwriting. `null` from the command means the file
// is gone; a metadata error rejects instead.
export interface FileSignature {
  mtimeMs: number;
  size: number;
}
