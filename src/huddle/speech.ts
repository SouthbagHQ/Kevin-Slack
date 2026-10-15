import { createLogger, preview, timer } from "../logger.js";

const log = createLogger("speech");

export type SpeechConfig = {
  apiKey: string;
  baseUrl: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  /** Sample rate of the 16-bit mono PCM the TTS model returns. */
  ttsSampleRate: number;
  ttsInstructions: string;
  language?: string;
};

/** Linear resampling of mono 16-bit PCM to 48 kHz floats; plenty for speech. */
export const pcm16ToFloat48k = (bytes: Uint8Array, sampleRate: number) => {
  const usable = bytes.length - (bytes.length % 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
  const input = new Float32Array(usable / 2);
  for (let index = 0; index < input.length; index++) input[index] = view.getInt16(index * 2, true) / 32_768;
  if (sampleRate === 48_000) return input;
  const ratio = sampleRate / 48_000;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let index = 0; index < output.length; index++) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    output[index] = input[left]! * (1 - fraction) + input[right]! * fraction;
  }
  return output;
};

/** What Kevin writes, turned into what a voice can say: no mrkdwn, links read as their labels. */
export const speakable = (text: string, names: (id: string) => string | undefined = () => undefined) => text
  .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_match, id: string, label?: string) => label ?? names(id) ?? "someone")
  .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
  .replace(/<(?:https?|mailto):[^|>]+\|([^>]+)>/g, "$1")
  .replace(/<(https?:[^>]+)>/g, "a link")
  .replace(/:[a-z0-9_+-]+:/g, "")
  .replace(/```[\s\S]*?```/g, "")
  .replace(/[*_~`]/g, "")
  .replace(/^\s*-\s*(Kevin|K|Him)\s*$/m, "")
  .replace(/\s+/g, " ")
  .trim();

/** Speech-to-text and text-to-speech through OpenRouter's audio endpoints. */
export class SpeechClient {
  constructor(private config: SpeechConfig) {}

  get models() {
    return { stt: this.config.sttModel, tts: this.config.ttsModel, voice: this.config.ttsVoice };
  }

  async transcribe(wavFile: Buffer) {
    const elapsed = timer();
    const response = await this.post("audio/transcriptions", {
      model: this.config.sttModel,
      input_audio: { data: wavFile.toString("base64"), format: "wav" },
      ...(this.config.language ? { language: this.config.language } : {}),
      temperature: 0,
    });
    const body = await response.json() as { text?: string };
    const text = body.text?.trim() ?? "";
    log.debug("Transcribed speech", { model: this.config.sttModel, bytes: wavFile.length, chars: text.length, ms: elapsed() });
    return text;
  }

  /** Kevin's voice as 48 kHz mono float samples. */
  async synthesize(text: string) {
    const elapsed = timer();
    const response = await this.post("audio/speech", {
      model: this.config.ttsModel,
      input: text,
      voice: this.config.ttsVoice,
      instructions: this.config.ttsInstructions,
      response_format: "pcm",
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const samples = pcm16ToFloat48k(bytes, this.config.ttsSampleRate);
    log.debug("Synthesized speech", { model: this.config.ttsModel, chars: text.length, seconds: Math.round(samples.length / 480) / 100, ms: elapsed() });
    return samples;
  }

  private async post(path: string, body: Record<string, unknown>) {
    let failure: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const elapsed = timer();
      try {
        const response = await fetch(`${this.config.baseUrl}/${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json", "X-OpenRouter-Title": "Kevin Slack" },
          body: JSON.stringify({ ...body, provider: { data_collection: "deny" } }),
          signal: AbortSignal.timeout(30_000),
        });
        if (response.ok) return response;
        const detail = await response.text();
        failure = new Error(`OpenRouter ${path} ${response.status}: ${preview(detail, 300)}`);
        const retryable = response.status === 429 || response.status >= 500;
        log.warn("Speech request rejected", { path, status: response.status, attempt: attempt + 1, retryable, body: preview(detail, 300), ms: elapsed() });
        if (!retryable) break;
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        log.warn("Speech request failed", { path, attempt: attempt + 1, error: failure.message, ms: elapsed() });
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw failure ?? new Error(`OpenRouter ${path} failed`);
  }
}
