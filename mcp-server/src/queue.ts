const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Serial task queue. Runs one task at a time and holds a gap after each task
 * settles, so bursts of tool calls reach the Figma UI thread at a steady pace.
 * Callers simply await `run()`; backed-up calls wait their turn.
 */
export class PacedQueue {
  /** Gap after each task, in ms. Read at the end of every task, so changes apply immediately. */
  gapMs: number;
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;

  constructor(gapMs: number) {
    this.gapMs = gapMs;
  }

  /** Tasks currently waiting or running. */
  get size(): number {
    return this.depth;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.depth++;
    const result = this.tail.then(task).finally(() => this.depth--);
    const gap = () => sleep(this.gapMs);
    this.tail = result.then(gap, gap);
    return result;
  }
}
