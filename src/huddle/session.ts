import { Application, createDecoder, createEncoder, Signal, type OpusDecoderHandle, type OpusEncoderHandle } from "libopus-wasm";
import { createLogger, type Logger } from "../logger.js";
import { ChimeLink, statusCodes, type ChimeAttendee, type ChimeMeeting } from "./chime-link.js";
import { LISTEN_RATE, Listener, wav, type Utterance } from "./listener.js";
import type { SpeechClient } from "./speech.js";

const FRAME = 960; // 20 ms at 48 kHz
const FRAME_MS = 20;
/** Frames the pacer may fall behind before it skips ahead instead of bursting. */
const MAX_CATCH_UP = 10;
const TRANSCRIPT_LINES = 60;

export type TranscriptLine = { at: number; speaker?: string; text: string; kevin?: boolean };

export type JoinedHuddle = {
  channel: string;
  callId: string;
  createdBy?: string;
  threadTs?: string;
  participants: string[];
  meeting: ChimeMeeting;
  attendee: ChimeAttendee;
};

export type SessionEvents = {
  /** Someone said something and it was transcribed. */
  onLine(session: HuddleSession, line: TranscriptLine): void;
  /** The session is over, for whatever reason. */
  onEnded(session: HuddleSession, reason: string): void;
};

/** Kevin's presence in one huddle: the Chime link, His ears, and His voice. */
export class HuddleSession {
  readonly channel: string;
  readonly callId: string;
  readonly joinedAt = Date.now();
  readonly transcript: TranscriptLine[] = [];
  participants: string[];
  createdBy?: string;
  threadTs?: string;
  /** When Kevin last finished saying something, for follow-up questions. */
  lastSpokeAt = 0;
  private link: ChimeLink;
  private listener: Listener;
  private decoder?: OpusDecoderHandle;
  private encoder?: OpusEncoderHandle;
  private pacer?: NodeJS.Timeout;
  private ticker?: NodeJS.Timeout;
  private playback: Float32Array[] = [];
  private playbackOffset = 0;
  private drained: (() => void)[] = [];
  private transcribing: Promise<void> = Promise.resolve();
  private ended = false;
  private log: Logger;

  constructor(joined: JoinedHuddle, private speech: SpeechClient, private events: SessionEvents) {
    this.channel = joined.channel;
    this.callId = joined.callId;
    this.participants = joined.participants;
    this.createdBy = joined.createdBy;
    this.threadTs = joined.threadTs;
    this.log = createLogger("huddle").with({ channel: this.channel, call: this.callId });
    this.link = new ChimeLink(joined.meeting, joined.attendee, {
      log: (level, message, fields) => this.log[level](message, fields),
      onSignaling: () => this.listener.reset(),
      onFrame: (frame) => this.listener.handleFrame(frame),
      onAudio: (payload) => this.hear(payload),
      onConnected: (reconnect) => this.log.info(reconnect ? "Huddle audio reconnected" : "Huddle audio connected"),
      onTerminal: (code, reason) => void this.end(code === statusCodes.meetingEnded ? "huddle-ended" : reason),
    });
    this.listener = new Listener(this.link.attendeeId, (utterance) => this.queueTranscription(utterance));
  }

  get speaking() {
    return this.playback.length > 0;
  }

  get someoneTalking() {
    return this.listener.inSpeech;
  }

  /** Attendees Chime lists besides Kevin, with Slack IDs when it gives them. */
  attendees() {
    return this.listener.attendees();
  }

  async start() {
    this.decoder = await createDecoder({ sampleRate: LISTEN_RATE, channels: 1 });
    this.encoder = await createEncoder({ application: Application.Voip, signal: Signal.Voice, channels: 1, sampleRate: 48_000, bitrate: 48_000, fec: true, packetLossPercent: 5, dtx: true });
    try {
      await this.link.start();
    } catch (error) {
      this.free();
      throw error;
    }
    this.startPacer();
    this.ticker = setInterval(() => this.listener.tick(), 100);
    this.log.info("Kevin joined the huddle audio");
  }

  /** Queues Kevin's voice; resolves once it has all been sent. */
  say(samples: Float32Array) {
    if (this.ended || !samples.length) return Promise.resolve();
    this.playback.push(samples);
    return new Promise<void>((resolve) => this.drained.push(resolve));
  }

  /** Cuts Kevin off mid-sentence. */
  hush() {
    this.playback = [];
    this.playbackOffset = 0;
    this.flushDrained();
  }

  note(line: TranscriptLine) {
    this.transcript.push(line);
    if (this.transcript.length > TRANSCRIPT_LINES) this.transcript.shift();
  }

  async leave() {
    await this.end("left");
  }

  private async end(reason: string) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.pacer);
    clearInterval(this.ticker);
    this.hush();
    await this.link.leave().catch(() => undefined);
    this.free();
    this.log.info("Kevin left the huddle", { reason, minutes: Math.round((Date.now() - this.joinedAt) / 60_000) });
    this.events.onEnded(this, reason);
  }

  private free() {
    this.decoder?.free();
    this.encoder?.free();
    this.decoder = undefined;
    this.encoder = undefined;
  }

  private hear(payload: Uint8Array) {
    if (!this.decoder) return;
    try {
      this.listener.push(this.decoder.decodeFloat(payload));
    } catch (error) {
      this.log.trace("Dropped an undecodable audio packet", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private queueTranscription(utterance: Utterance) {
    // Transcribed one at a time so lines land in the order they were spoken.
    this.transcribing = this.transcribing.then(async () => {
      if (this.ended) return;
      try {
        const text = await this.speech.transcribe(wav(utterance.pcm));
        if (!text || this.ended || isNoise(text)) return;
        const line: TranscriptLine = { at: utterance.endedAt, speaker: utterance.slackUserId, text };
        this.note(line);
        this.log.debug("Heard speech", { speaker: utterance.slackUserId, ms: utterance.durationMs, chars: text.length });
        this.events.onLine(this, line);
      } catch (error) {
        this.log.failure("Transcription failed", error, { ms: utterance.durationMs });
      }
    });
  }

  private startPacer() {
    let base = performance.now();
    let sent = 0;
    this.pacer = setInterval(() => {
      if (!this.encoder) return;
      if (Math.floor((performance.now() - base) / FRAME_MS) - sent > MAX_CATCH_UP) {
        // After a stall, carry on from now rather than rushing out a burst.
        base = performance.now() - FRAME_MS;
        sent = 0;
      }
      const target = Math.floor((performance.now() - base) / FRAME_MS);
      while (sent < target) {
        sent++;
        this.link.sendAudio(this.encoder.encodeFloat(this.nextFrame()));
      }
    }, 10);
  }

  private nextFrame() {
    const frame = new Float32Array(FRAME);
    let written = 0;
    while (written < FRAME && this.playback.length) {
      const current = this.playback[0]!;
      const take = Math.min(FRAME - written, current.length - this.playbackOffset);
      frame.set(current.subarray(this.playbackOffset, this.playbackOffset + take), written);
      written += take;
      this.playbackOffset += take;
      if (this.playbackOffset >= current.length) {
        this.playback.shift();
        this.playbackOffset = 0;
      }
    }
    if (written && !this.playback.length) {
      this.lastSpokeAt = Date.now();
      this.flushDrained();
    }
    return frame;
  }

  private flushDrained() {
    for (const resolve of this.drained.splice(0)) resolve();
  }
}

/** Transcription models hallucinate these out of breath and background hum. */
const NOISE = /^(?:\W*|you\.?|thanks for watching!?|uh+\.?|um+\.?|hmm+\.?|\[.*\]|\(.*\))$/i;
export const isNoise = (text: string) => NOISE.test(text.trim());
