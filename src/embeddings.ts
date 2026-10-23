import { createLogger, preview, timer } from "./logger.js";

const log = createLogger("embeddings");

export type Embedder = { embed(inputs: string[], timeoutMs?: number): Promise<Float32Array[]> };

export type EmbeddingClientOptions = {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
};

/** Scales a vector to unit length, so a dot product is the cosine similarity. */
export const normalize = (values: ArrayLike<number>) => {
  const vector = Float32Array.from(values);
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm) for (let index = 0; index < vector.length; index++) vector[index]! /= norm;
  return vector;
};

export const cosine = (a: Float32Array, b: Float32Array) => {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let index = 0; index < a.length; index++) dot += a[index]! * b[index]!;
  return dot;
};

/** An OpenAI-compatible embeddings endpoint; vectors come back normalized, in input order. */
export class EmbeddingClient implements Embedder {
  constructor(private key: string, private options: EmbeddingClientOptions) {}

  async embed(inputs: string[], timeoutMs = this.options.timeoutMs ?? 15_000) {
    if (!inputs.length) return [];
    const elapsed = timer();
    const response = await fetch(`${this.options.baseUrl}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", ...this.options.extraHeaders },
      body: JSON.stringify({ model: this.options.model, input: inputs, ...this.options.extraBody }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      log.warn("Embedding request rejected", { model: this.options.model, status: response.status, inputs: inputs.length, body: preview(detail, 300), ms: elapsed() });
      throw new Error(`Embeddings ${response.status}: ${preview(detail, 200)}`);
    }
    const body = await response.json() as { data?: { index?: number; embedding?: number[] }[] };
    const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== inputs.length || data.some(({ embedding }) => !Array.isArray(embedding) || !embedding.length)) {
      throw new Error(`Embeddings returned ${data.length} vectors for ${inputs.length} inputs`);
    }
    log.debug("Embedded", { model: this.options.model, inputs: inputs.length, dimensions: data[0]!.embedding!.length, ms: elapsed() });
    return data.map(({ embedding }) => normalize(embedding!));
  }
}
