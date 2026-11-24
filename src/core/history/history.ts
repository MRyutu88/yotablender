// Undo/redo with the command pattern. Commands are small closures over the data they changed:
// transforms store only moved vertices (before/after), topology ops store mesh snapshots.
// History is capped by step count and by approximate memory.

export interface Command {
  label: string;
  undo(): void;
  redo(): void;
  /** Approximate memory held by this command, in bytes. */
  bytes: number;
}

export class History {
  private stack: Command[] = [];
  private index = 0; // number of applied commands
  private listeners = new Set<() => void>();

  constructor(
    public maxSteps = 100,
    public maxBytes = 64 * 1024 * 1024,
  ) {}

  /** Records a command that has already been applied. */
  push(cmd: Command): void {
    this.stack.length = this.index;
    this.stack.push(cmd);
    this.index++;
    this.trim();
    this.emit();
  }

  /** Replaces the most recent command (used by "Adjust Last Operation"). */
  replaceLast(cmd: Command): void {
    if (this.index === 0) return this.push(cmd);
    this.stack[this.index - 1] = cmd;
    this.stack.length = this.index;
    this.emit();
  }

  get last(): Command | undefined {
    return this.index > 0 ? this.stack[this.index - 1] : undefined;
  }

  canUndo(): boolean {
    return this.index > 0;
  }
  canRedo(): boolean {
    return this.index < this.stack.length;
  }

  undo(): Command | undefined {
    if (!this.canUndo()) return undefined;
    const c = this.stack[--this.index];
    c.undo();
    this.emit();
    return c;
  }

  redo(): Command | undefined {
    if (!this.canRedo()) return undefined;
    const c = this.stack[this.index++];
    c.redo();
    this.emit();
    return c;
  }

  clear(): void {
    this.stack = [];
    this.index = 0;
    this.emit();
  }

  get size(): number {
    return this.stack.length;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private trim(): void {
    let bytes = this.stack.reduce((s, c) => s + c.bytes, 0);
    while (this.stack.length > 1 && (this.stack.length > this.maxSteps || bytes > this.maxBytes)) {
      bytes -= this.stack[0].bytes;
      this.stack.shift();
      this.index--;
    }
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
