import type { SignalFrame } from "./signaling.js";

/** The rate Kevin listens at: plenty for speech, and what transcription models expect. */
export const LISTEN_RATE = 16_000;
const CHUNK = LISTEN_RATE / 50; // 20 ms

// DefaultVolumeIndicatorAdapter in amazon-chime-sdk-js maps -42 dB..-14 dB attenuation onto 0..1.
export const normalizedVolume = (attenuation: number) => Math.min(1, Math.max(0, (-attenuation + 42) / 28));

/** The Slack user ID inside a Chime external user ID; Slack puts its team ID first, so the last match wins. */
export const slackUserFromExternal = (external?: string) => (external ? [...external.matchAll(/(?<![A-Z0-9])[UW][A-Z0-9]{6,}/g)].at(-1)?.[0] : undefined);

export type Utterance = {
  /** 16 kHz mono 16-bit samples. */
  pcm: Int16Array;
  durationMs: number;
  /** The attendee loudest while it was spoken, when Chime said. */
  attendeeId?: string;
  slackUserId?: string;
  endedAt: number;
};

export type ListenerOptions = {
  /** Quiet after speech that ends an utterance. */
  endSilenceMs?: number;
  /** Speech shorter than this is a cough, not a sentence. */
  minSpeechMs?: number;
  maxUtteranceMs?: number;
  preRollMs?: number;
  /** RMS below this is never speech, whatever the noise floor (about -40 dBFS). */
  minRms?: number;
};

const rms = (samples: Float32Array) => {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / (samples.length || 1));
};

/**
 * Turns the meeting's mixed audio into utterances: an energy voice detector
 * with an adaptive noise floor, a little pre-roll so first syllables survive,
 * and speaker attribution from Chime's per-attendee volume metadata.
 */
export class Listener {
  private pending = new Float32Array(0);
  private preRoll: Float32Array[] = [];
  private speech: Float32Array[] = [];
  private speaking = false;
  private run = 0;
  private quietMs = 0;
  private voicedMs = 0;
  private floor = 0.004;
  private lastAudioAt = 0;
  private streams = new Map<number, { attendeeId: string; external?: string; muted?: boolean }>();
  private loudness = new Map<string, number>();
  private options: Required<ListenerOptions>;

  constructor(private selfAttendeeId: string, private onUtterance: (utterance: Utterance) => void, options: ListenerOptions = {}) {
    this.options = { endSilenceMs: 800, minSpeechMs: 350, maxUtteranceMs: 30_000, preRollMs: 300, minRms: 0.01, ...options };
  }

  /** Attendees Chime currently lists, other than Kevin, with their mute state when Chime has reported it. */
  attendees() {
    const seen = new Map<string, { attendeeId: string; slackUserId?: string; muted?: boolean }>();
    for (const { attendeeId, external, muted } of this.streams.values()) {
      if (attendeeId === this.selfAttendeeId) continue;
      seen.set(attendeeId, { attendeeId, slackUserId: slackUserFromExternal(external), ...(muted !== undefined ? { muted } : {}) });
    }
    return [...seen.values()];
  }

  get inSpeech() {
    return this.speaking;
  }

  /** Decoded 16 kHz mono samples, in arrival order. */
  push(samples: Float32Array, now = Date.now()) {
    this.lastAudioAt = now;
    const joined = new Float32Array(this.pending.length + samples.length);
    joined.set(this.pending);
    joined.set(samples, this.pending.length);
    let offset = 0;
    for (; offset + CHUNK <= joined.length; offset += CHUNK) this.chunk(joined.slice(offset, offset + CHUNK), now);
    this.pending = joined.slice(offset);
  }

  /** Ends an utterance when the audio itself stopped arriving (Chime sends nothing during silence). */
  tick(now = Date.now()) {
    if (this.speaking && now - this.lastAudioAt >= this.options.endSilenceMs) this.finish(now);
  }

  /** Forgets presence, for a rebuilt connection that will resend it. */
  reset() {
    this.streams.clear();
  }

  handleFrame(frame: SignalFrame) {
    for (const stream of frame.audio_stream_id_info?.streams ?? []) {
      const known = this.streams.get(stream.audio_stream_id);
      // An entry with an attendee announces a stream; one with only a mute state changes it; one with neither is a stream leaving.
      if (stream.attendee_id) this.streams.set(stream.audio_stream_id, { attendeeId: stream.attendee_id, external: stream.external_user_id, muted: stream.muted ?? known?.muted });
      else if (stream.muted !== undefined) {
        if (known) known.muted = stream.muted;
      } else this.streams.delete(stream.audio_stream_id);
    }
    if (!this.speaking) return;
    for (const state of frame.audio_metadata?.attendee_states ?? []) {
      if (state.volume === undefined) continue;
      const stream = this.streams.get(state.audio_stream_id);
      if (!stream || stream.attendeeId === this.selfAttendeeId) continue;
      this.loudness.set(stream.attendeeId, (this.loudness.get(stream.attendeeId) ?? 0) + normalizedVolume(state.volume));
    }
  }

  private chunk(chunk: Float32Array, now: number) {
    const level = rms(chunk);
    const voiced = level > Math.max(this.options.minRms, this.floor * 3);
    if (!voiced && !this.speaking) this.floor = this.floor * 0.95 + level * 0.05;
    if (!this.speaking) {
      this.preRoll.push(chunk);
      if (this.preRoll.length * 20 > this.options.preRollMs) this.preRoll.shift();
      this.run = voiced ? this.run + 1 : 0;
      if (this.run >= 3) {
        this.speaking = true;
        this.speech = [...this.preRoll];
        this.preRoll = [];
        this.voicedMs = this.run * 20;
        this.quietMs = 0;
        this.loudness.clear();
      }
      return;
    }
    this.speech.push(chunk);
    if (voiced) {
      this.voicedMs += 20;
      this.quietMs = 0;
    } else this.quietMs += 20;
    if (this.quietMs >= this.options.endSilenceMs || this.speech.length * 20 >= this.options.maxUtteranceMs) this.finish(now);
  }

  private finish(now: number) {
    // Keep a little of the trailing quiet; the rest is just the pause that ended the utterance.
    const chunks = this.speech.slice(0, this.speech.length - Math.max(0, Math.floor((this.quietMs - 200) / 20)));
    const voicedMs = this.voicedMs;
    this.speaking = false;
    this.speech = [];
    this.run = 0;
    this.quietMs = 0;
    this.voicedMs = 0;
    if (voicedMs < this.options.minSpeechMs) return;
    const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const pcm = new Int16Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      for (const sample of chunk) pcm[offset++] = Math.round(Math.max(-1, Math.min(1, sample)) * 32_767);
    }
    const loudest = [...this.loudness].sort((a, b) => b[1] - a[1])[0]?.[0];
    const external = loudest ? [...this.streams.values()].find(({ attendeeId }) => attendeeId === loudest)?.external : undefined;
    this.loudness.clear();
    this.onUtterance({ pcm, durationMs: Math.round((length / LISTEN_RATE) * 1000), attendeeId: loudest, slackUserId: slackUserFromExternal(external), endedAt: now });
  }
}

/** A 16-bit mono PCM WAV file. */
export const wav = (pcm: Int16Array, sampleRate = LISTEN_RATE) => {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};
