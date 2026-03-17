/**
 * Generic polling manager that encapsulates timer state, cycle execution,
 * and start/stop lifecycle for a recurring background task.
 */
export class PollingManager<TResult = any> {
  public timer: ReturnType<typeof setInterval> | null = null;
  public running = false;
  public lastRunAt: Date | null = null;
  public lastResult: TResult | null = null;

  constructor(
    public readonly name: string,
    private cycleFn: () => Promise<TResult>
  ) {}

  async runCycle(): Promise<TResult | null> {
    if (this.running) {
      console.log(`[${this.name}] Already running, skipping`);
      return null;
    }
    this.running = true;
    try {
      const result = await this.cycleFn();
      this.lastResult = result;
      this.lastRunAt = new Date();
      return result;
    } catch (error: any) {
      console.error(`[${this.name}] Cycle error:`, error.message);
      throw error;
    } finally {
      this.running = false;
    }
  }

  start(intervalMs: number) {
    this.stop();
    console.log(`[${this.name}] Starting with interval ${intervalMs}ms`);
    this.timer = setInterval(() => {
      this.runCycle().catch(() => {});
    }, intervalMs);
    // Run immediately on start
    this.runCycle().catch(() => {});
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log(`[${this.name}] Stopped`);
    }
  }

  getStatus() {
    return {
      name: this.name,
      active: this.timer !== null,
      running: this.running,
      lastRunAt: this.lastRunAt?.toISOString() || null,
      lastResult: this.lastResult,
    };
  }
}
