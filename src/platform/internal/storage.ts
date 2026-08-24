// /platform/internal/storage.ts
// Provider-neutral object-storage interface for large artifacts, evidence
// payloads, experiment artifacts, and execution snapshots (architecture
// §26, §2.3). WORK-001 provides the boundary only; WORK-002 (DATA-003)
// wires a concrete implementation.

export interface StorageObject {
  key: string;
  size: number;
  contentType: string;
  etag?: string;
  lastModified?: Date;
  metadata?: Record<string, string>;
}

export interface PutObjectInput {
  key: string;
  body: Uint8Array | string | ReadableStream<Uint8Array>;
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface ObjectStorage {
  put(input: PutObjectInput): Promise<StorageObject>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  stat(key: string): Promise<StorageObject | undefined>;
}

export class UnconfiguredObjectStorage implements ObjectStorage {
  async put(): Promise<StorageObject> {
    throw new Error("storage: not configured (see WORK-002 / DATA-003)");
  }
  async get(): Promise<Uint8Array> {
    throw new Error("storage: not configured (see WORK-002 / DATA-003)");
  }
  async delete(): Promise<void> {
    throw new Error("storage: not configured (see WORK-002 / DATA-003)");
  }
  async stat(): Promise<StorageObject | undefined> {
    throw new Error("storage: not configured (see WORK-002 / DATA-003)");
  }
}
