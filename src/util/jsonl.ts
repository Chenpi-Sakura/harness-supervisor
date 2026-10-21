import { StringDecoder } from "node:string_decoder";

export class JsonlDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private closed = false;

  constructor(
    private readonly onRecord: (record: Record<string, unknown>, raw: string) => void,
    private readonly onInvalid?: (raw: string, error: Error) => void,
    private readonly maxBufferedChars = 32 * 1024 * 1024,
  ) {}

  push(chunk: Buffer | string): void {
    if (this.closed) return;
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    if (this.buffer.length > this.maxBufferedChars) {
      this.onInvalid?.("[buffer too large]", new Error("JSONL record exceeded buffer limit"));
      this.buffer = "";
      return;
    }
    this.drain(false);
  }

  end(): void {
    if (this.closed) return;
    this.buffer += this.decoder.end();
    this.drain(true);
    this.closed = true;
  }

  private drain(final: boolean): void {
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.parseLine(line);
    }
    if (final && this.buffer.trim().length > 0) {
      this.parseLine(this.buffer.replace(/\r$/, ""));
      this.buffer = "";
    }
  }

  private parseLine(line: string): void {
    if (line.length === 0) return;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        this.onInvalid?.(line, new Error("JSONL record is not an object"));
        return;
      }
      this.onRecord(parsed as Record<string, unknown>, line);
    } catch (error) {
      this.onInvalid?.(line, error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export function serializeJsonLine(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}
