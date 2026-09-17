import { createLogger, timer } from "./logger.js";

export type Queued<T> = { key: string; sender: string; priority: number; value: T };
export type Batch<T> = { values: T[]; omitted: number };

type Pending<T> = Batch<T> & { sender: string; priority: number; queuedAt: number };
type Conversation<T> = { pending: Pending<T>[]; running: boolean; timer?: NodeJS.Timeout };

const log = createLogger("queue");

export class ConversationQueue<T> {
  private conversations = new Map<string, Conversation<T>>();
  private active = 0;

  constructor(
    private process: (batch: Batch<T>) => Promise<void>,
    private options = { concurrency: 4, debounceMs: 900, maxBatchMessages: 20, maxPendingBatches: 50 },
  ) {}

  /** Queue depth across every conversation; useful context on every queue line. */
  private depth() {
    return [...this.conversations.values()].reduce((total, conversation) => total + conversation.pending.length, 0);
  }

  private stats() {
    return { active: this.active, conversations: this.conversations.size, queued: this.depth() };
  }

  enqueue(item: Queued<T>) {
    const conversation = this.conversations.get(item.key) ?? { pending: [], running: false };
    this.conversations.set(item.key, conversation);
    const last = conversation.pending.at(-1);
    if (last?.sender === item.sender) {
      last.priority = Math.max(last.priority, item.priority);
      last.values.push(item.value);
      if (last.values.length > this.options.maxBatchMessages) {
        last.values.shift();
        last.omitted++;
        log.warn("Batch full; dropped the oldest message", {
          conversation: item.key,
          sender: item.sender,
          maxBatchMessages: this.options.maxBatchMessages,
          omitted: last.omitted,
        });
      }
      log.debug("Message merged into the pending batch", {
        conversation: item.key,
        sender: item.sender,
        batchSize: last.values.length,
        priority: last.priority,
        ...this.stats(),
      });
    } else {
      if (conversation.pending.length >= this.options.maxPendingBatches) {
        log.warn("Conversation queue full; message rejected", {
          conversation: item.key,
          sender: item.sender,
          pending: conversation.pending.length,
          maxPendingBatches: this.options.maxPendingBatches,
          ...this.stats(),
        });
        return false;
      }
      conversation.pending.push({ sender: item.sender, priority: item.priority, values: [item.value], omitted: 0, queuedAt: Date.now() });
      log.debug("Message queued", {
        conversation: item.key,
        sender: item.sender,
        priority: item.priority,
        pending: conversation.pending.length,
        ...this.stats(),
      });
    }
    if (!conversation.running && !conversation.timer) {
      conversation.timer = setTimeout(() => {
        conversation.timer = undefined;
        log.trace("Debounce elapsed", { conversation: item.key, debounceMs: this.options.debounceMs });
        this.pump();
      }, this.options.debounceMs);
    }
    return true;
  }

  cancel(key: string) {
    const conversation = this.conversations.get(key);
    if (!conversation) {
      log.trace("Nothing to cancel", { conversation: key });
      return;
    }
    log.info("Conversation cancelled", { conversation: key, dropped: conversation.pending.length, running: conversation.running });
    conversation.pending = [];
    clearTimeout(conversation.timer);
    conversation.timer = undefined;
    if (!conversation.running) this.conversations.delete(key);
  }

  private pump() {
    while (this.active < this.options.concurrency) {
      const ready = [...this.conversations.entries()]
        .filter(([, conversation]) => !conversation.running && !conversation.timer && conversation.pending.length)
        .sort(([, a], [, b]) => b.pending[0]!.priority - a.pending[0]!.priority || a.pending[0]!.queuedAt - b.pending[0]!.queuedAt)[0];
      if (!ready) {
        log.trace("Nothing ready to run", this.stats());
        return;
      }
      const [key, conversation] = ready;
      const batch = conversation.pending.shift()!;
      conversation.running = true;
      this.active++;
      const elapsed = timer();
      const started = {
        conversation: key,
        sender: batch.sender,
        priority: batch.priority,
        messages: batch.values.length,
        omitted: batch.omitted,
        waitedMs: Date.now() - batch.queuedAt,
        ...this.stats(),
      };
      log.debug("Conversation started", started);
      void this.process({ values: batch.values, omitted: batch.omitted })
        .then(() => log.debug("Conversation finished", { conversation: key, sender: batch.sender, ms: elapsed() }))
        .catch((error) => log.failure("Conversation failed", error, { conversation: key, sender: batch.sender, messages: batch.values.length, ms: elapsed() }))
        .finally(() => {
          this.active--;
          conversation.running = false;
          if (!conversation.pending.length) this.conversations.delete(key);
          this.pump();
        });
    }
    log.debug("Concurrency limit reached", { ...this.stats(), concurrency: this.options.concurrency });
  }
}
