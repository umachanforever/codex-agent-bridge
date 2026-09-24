import { record } from "../core/canonical.js";
import { HttpError } from "./errors.js";
import type { NormalizedEvent } from "./chat-normalize.js";

/** Per-item state keeps authoritative completion text separate from deltas. */
interface MessageText {
  text: string;
  emitted: string;
  phase?: string;
  completed: boolean;
}

/** Normalizes agent text without confusing commentary, completion and replay. */
export class AgentText {
  readonly #messages = new Map<string, MessageText>();
  #lastEmittedId?: string;
  #flushed = false;

  /** Schema responses must remain retractable until the final item is known. */
  constructor(private readonly structuredOutput = false) {}

  /** Releases one JSON document only at successful turn completion. */
  finish(): NormalizedEvent[] {
    if (!this.structuredOutput || this.#flushed) return [];
    this.#flushed = true;
    const messages = [...this.#messages.values()];
    const finals = messages.filter((m) => m.phase === "final_answer");
    const chosen = (
      finals.length ? finals : messages.filter((m) => m.phase !== "commentary")
    ).at(-1);
    const text = chosen?.text ?? "";
    try {
      JSON.parse(text);
    } catch {
      throw new HttpError(
        502,
        "The final structured response is not valid JSON.",
        "server_error",
        "invalid_structured_output",
      );
    }
    return [{ delta: { content: text } }];
  }

  /** Processes text and lifecycle events while preserving incremental output. */
  normalize(
    method: string,
    params: Record<string, unknown>,
  ): NormalizedEvent[] {
    const lifecycle = method === "item/started" || method === "item/completed";
    const item = lifecycle ? record(params.item) : undefined;
    if (lifecycle && item?.type !== "agentMessage") return [];
    const id = lifecycle ? item?.id : params.itemId;
    if (typeof id !== "string") return [];
    let state = this.#messages.get(id);
    if (!state) {
      state = { text: "", emitted: "", completed: false };
      this.#messages.set(id, state);
    }
    if (lifecycle && typeof item?.phase === "string") state.phase = item.phase;
    if (state.phase === "commentary") {
      if (state.emitted) this.#mismatch();
      return [];
    }
    if (method === "item/agentMessage/delta") {
      if (state.completed || typeof params.delta !== "string") return [];
      state.text += params.delta;
    } else if (method === "item/completed" && typeof item?.text === "string") {
      if (!this.structuredOutput && !item.text.startsWith(state.emitted))
        this.#mismatch();
      state.text = item.text;
      state.completed = true;
    } else return [];
    if (this.structuredOutput) return [];
    const suffix = state.text.slice(state.emitted.length);
    if (!suffix) return [];
    const separator =
      this.#lastEmittedId !== undefined && this.#lastEmittedId !== id
        ? "\n\n"
        : "";
    state.emitted = state.text;
    this.#lastEmittedId = id;
    return [{ delta: { content: separator + suffix } }];
  }

  /** Never present an irretractable streamed prefix as a successful answer. */
  #mismatch(): never {
    throw new HttpError(
      502,
      "Agent message completion conflicts with streamed text.",
      "server_error",
      "agent_text_mismatch",
    );
  }
}
