import type { PendingToolCall, StoredToolCall } from "../continuation/state.js";
import { matchesTurn } from "./correlation.js";

/** Arrival-ordered app-server activity retained for one Codex turn. */
export type IngressEvent =
  | { type: "notification"; method: string; params: unknown }
  | { type: "dynamic_tool"; call: PendingToolCall }
  | { type: "raw_dynamic_tool"; call: StoredToolCall; params: unknown };

/** Bounded turn inbox with cancellation and raw-response batch correlation. */
export class IngressQueue {
  #events: IngressEvent[] = [];
  #waiters = new Set<() => void>();
  #overflow: Error | undefined;
  #transportFailure: Error | undefined;
  #callsCancelled = false;

  constructor(private readonly rejectCall: (call: PendingToolCall) => void) {}

  /** Whether the inbox has no retained activity. */
  get empty(): boolean {
    return this.#events.length === 0;
  }

  /** Whether at least one notification is ready for terminal collection. */
  get hasNotification(): boolean {
    return this.#events.some((event) => event.type === "notification");
  }

  /** Why terminal collection can no longer succeed. */
  get failureReason(): "transport_failed" | "queue_overflowed" | undefined {
    if (this.#transportFailure) return "transport_failed";
    if (this.#overflow) return "queue_overflowed";
    return undefined;
  }

  /** Returns the first event without removing it. */
  peek(): IngressEvent | undefined {
    return this.#events[0];
  }

  /** Accepts one event, rejecting tool callbacks that cannot be retained. */
  enqueue(event: IngressEvent): void {
    if (event.type === "dynamic_tool" && this.#callsCancelled) return;
    if (this.#overflow || this.#events.length >= 1_024) {
      this.#overflow ??= new Error("App-server activity queue overflowed.");
      if (event.type === "dynamic_tool") this.rejectCall(event.call);
      this.notify();
      return;
    }
    this.#events.push(event);
    this.notify();
  }

  /** Records a transport close and wakes all pending readers. */
  failTransport(error: Error): void {
    this.#transportFailure = error;
    this.notify();
  }

  /** Wakes readers after an external lifecycle transition. */
  notify(): void {
    for (const wake of [...this.#waiters]) wake();
  }

  /** Throws the highest-priority terminal failure. */
  assertHealthy(): void {
    if (this.#transportFailure) throw this.#transportFailure;
    if (this.#overflow) throw this.#overflow;
  }

  /** Removes the next event. */
  shift(): IngressEvent | undefined {
    return this.#events.shift();
  }

  /** Removes every retained event in arrival order. */
  drainAll(): IngressEvent[] {
    return this.#events.splice(0);
  }

  /** Removes notifications while preserving pending tool activity. */
  drainNotifications(): Array<Extract<IngressEvent, { type: "notification" }>> {
    const notifications: Array<
      Extract<IngressEvent, { type: "notification" }>
    > = [];
    this.#events = this.#events.filter((event) => {
      if (event.type !== "notification") return true;
      notifications.push(event);
      return false;
    });
    return notifications;
  }

  /** Discards tool callbacks after the owning turn is interrupted. */
  markDynamicCallsCancelled(): void {
    this.#callsCancelled = true;
    this.#events = this.#events.filter(
      (event) => event.type === "notification",
    );
    this.notify();
  }

  /** Waits for relevant activity, failure, cancellation, or an optional deadline. */
  async wait(
    signal: AbortSignal,
    {
      ready = (): boolean => this.#events.length > 0,
      timeoutMs,
    }: { ready?: () => boolean; timeoutMs?: number } = {},
  ): Promise<boolean> {
    if (timeoutMs !== undefined && timeoutMs <= 0) return false;
    const canAdvance = (): boolean =>
      ready() ||
      this.#overflow !== undefined ||
      this.#transportFailure !== undefined ||
      signal.aborted;
    if (canAdvance()) return true;
    return await new Promise<boolean>((resolve) => {
      let finished = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (progressed: boolean): void => {
        if (finished) return;
        finished = true;
        this.#waiters.delete(check);
        signal.removeEventListener("abort", check);
        if (timer) clearTimeout(timer);
        resolve(progressed);
      };
      const check = (): void => {
        if (canAdvance()) finish(true);
      };
      this.#waiters.add(check);
      signal.addEventListener("abort", check, { once: true });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => finish(false), timeoutMs);
        timer.unref();
      }
      check();
    });
  }

  /** Waits until a raw response closes all callbacks in one dynamic-tool batch. */
  async waitForDynamicToolBatch(
    signal: AbortSignal,
    threadId: string,
    turnId: string,
    precedingBoundary: boolean,
  ): Promise<boolean> {
    let lastCount = 0;
    let quietUntil = 0;
    for (;;) {
      this.assertHealthy();
      if (signal.aborted) return false;
      let closed = precedingBoundary;
      let lateCallback = false;
      let count = 0;
      for (const event of this.#events) {
        if (event.type === "dynamic_tool") {
          count += 1;
          if (closed) lateCallback = true;
          continue;
        }
        if (!matchesTurn(event.params, threadId, turnId)) continue;
        if (
          event.type === "raw_dynamic_tool" ||
          event.method === "rawResponseItem/completed"
        ) {
          closed = false;
          lateCallback = false;
        } else if (event.method === "rawResponse/completed") {
          closed = true;
        }
      }
      if (count !== lastCount) {
        lastCount = count;
        quietUntil = Date.now() + 1_000;
      }
      if (closed && (!lateCallback || Date.now() >= quietUntil)) return true;
      const length = this.#events.length;
      await this.wait(signal, {
        ready: () => this.#events.length !== length,
        ...(closed && lateCallback
          ? { timeoutMs: quietUntil - Date.now() }
          : {}),
      });
    }
  }

  /** Rejects retained dynamic callbacks when execution exits unsuspended. */
  rejectQueuedDynamicCalls(): void {
    for (const event of this.#events)
      if (event.type === "dynamic_tool") this.rejectCall(event.call);
  }
}
