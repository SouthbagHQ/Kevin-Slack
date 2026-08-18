export type Queued<T> = { key: string; sender: string; priority: number; value: T };
export type Batch<T> = { values: T[]; omitted: number };

type Pending<T> = Batch<T> & { sender: string; priority: number; queuedAt: number };
type Conversation<T> = { pending: Pending<T>[]; running: boolean; timer?: NodeJS.Timeout };

export class ConversationQueue<T> {
  private conversations = new Map<string, Conversation<T>>();
  private active = 0;

  constructor(
    private process: (batch: Batch<T>) => Promise<void>,
    private options = { concurrency: 4, debounceMs: 900, maxBatchMessages: 20, maxPendingBatches: 50 },
  ) {}

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
      }
    } else {
      if (conversation.pending.length >= this.options.maxPendingBatches) return false;
      conversation.pending.push({ sender: item.sender, priority: item.priority, values: [item.value], omitted: 0, queuedAt: Date.now() });
    }
    if (!conversation.running && !conversation.timer) {
      conversation.timer = setTimeout(() => {
        conversation.timer = undefined;
        this.pump();
      }, this.options.debounceMs);
    }
    return true;
  }

  cancel(key: string) {
    const conversation = this.conversations.get(key);
    if (!conversation) return;
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
      if (!ready) return;
      const [key, conversation] = ready;
      const batch = conversation.pending.shift()!;
      conversation.running = true;
      this.active++;
      void this.process({ values: batch.values, omitted: batch.omitted }).catch((error) => console.error("Conversation failed", error)).finally(() => {
        this.active--;
        conversation.running = false;
        if (!conversation.pending.length) this.conversations.delete(key);
        this.pump();
      });
    }
  }
}
