import type { Terminal } from "@xterm/xterm";
import type { CastEvent, CastHeader } from "./castParser";

// xterm parses writes asynchronously. Finish parsing the preceding output
// before applying a recorded resize, or a seek/reset requested mid-write.
export class CastScreen {
  private index = 0;
  private target = 0;
  private reset = false;
  private writing = false;
  private disposed = false;

  constructor(private term: Terminal, private header: CastHeader, private events: CastEvent[]) {}

  show(end: number, rewind = false) {
    this.target = end;
    this.reset ||= rewind;
    this.flush();
  }

  dispose() { this.disposed = true; }

  private flush() {
    if (this.disposed || this.writing) return;
    if (this.reset) {
      this.term.reset();
      this.term.resize(this.header.width, this.header.height);
      this.index = 0;
      this.reset = false;
    }
    while (this.index < this.target) {
      const event = this.events[this.index++];
      if (event.code === "r") {
        const match = /^(\d+)x(\d+)$/.exec(event.data);
        if (match) {
          const cols = Number(match[1]), rows = Number(match[2]);
          if (Number.isSafeInteger(cols) && Number.isSafeInteger(rows) && cols > 0 && rows > 0) this.term.resize(cols, rows);
        }
      }
      if (event.code !== "o") continue;
      let output = event.data;
      while (this.index < this.target && this.events[this.index].code === "o" && output.length < 65536) {
        output += this.events[this.index++].data;
      }
      this.writing = true;
      this.term.write(output, () => {
        this.writing = false;
        this.flush();
      });
      return;
    }
  }
}
