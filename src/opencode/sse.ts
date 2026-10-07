// Minimal incremental parser for text/event-stream (WHATWG SSE framing).

export interface SseMessage {
  id: string | null;
  event: string | null;
  data: string;
}

export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event: string | null = null;
  private id: string | null = null;

  /** Feeds a decoded chunk and returns every complete message it finished. */
  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      // A lone trailing "\r" may be the first half of "\r\n"; wait for more input.
      if (match[0] === "\r" && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const msg = this.line(line);
      if (msg) out.push(msg);
    }
    return out;
  }

  private line(line: string): SseMessage | undefined {
    if (line === "") {
      if (this.data.length === 0) {
        this.event = null;
        return undefined;
      }
      const msg = { id: this.id, event: this.event, data: this.data.join("\n") };
      this.data = [];
      this.event = null;
      return msg;
    }
    if (line.startsWith(":")) return undefined; // comment / heartbeat
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id") this.id = value;
    return undefined;
  }
}
