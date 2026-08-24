// tests/helpers.ts — shared test utilities.
import type { LogRecord, LogSink } from "@cp/platform";

export class CapturingLogSink implements LogSink {
  readonly records: LogRecord[] = [];
  emit(record: LogRecord): void {
    this.records.push(record);
  }
  reset(): void {
    this.records.length = 0;
  }
  find(msg: string): LogRecord | undefined {
    return this.records.find((r) => r.msg === msg);
  }
  findBySubstring(needle: string): LogRecord[] {
    return this.records.filter((r) => r.msg.includes(needle));
  }
  text(): string {
    return this.records.map((r) => JSON.stringify(r)).join("\n");
  }
}
