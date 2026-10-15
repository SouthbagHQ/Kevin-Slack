import { readFileSync } from "node:fs";
import protobuf from "protobufjs";
import WebSocket from "ws";

// The Chime signaling protocol, vendored from amazon-chime-sdk-js v3.31.0 by way of HuddleFM.
const root = protobuf.parse(readFileSync(new URL("./SignalingProtocol.proto", import.meta.url), "utf8"), { keepCase: true }).root;
const Frame = root.lookupType("SdkSignalFrame");
const frameTypes = (Frame.lookupEnum("Type") as protobuf.Enum).values;

export type FrameTypeName = keyof typeof frameTypes & string;

export type TurnCredentials = { username: string; password: string; ttl?: number; uris: string[] };

export type AudioStreamIdInfo = {
  audio_stream_id: number;
  attendee_id?: string;
  external_user_id?: string;
  muted?: boolean;
  dropped?: boolean;
};

export type AudioAttendeeState = { audio_stream_id: number; volume?: number; muted?: boolean };

/** A decoded frame, as protobufjs returns it with enums named. */
export type SignalFrame = {
  type: string;
  error?: { status?: number; description?: string };
  joinack?: { turn_credentials?: TurnCredentials };
  suback?: { duplex?: string; sdp_answer?: string };
  audio_stream_id_info?: { streams?: AudioStreamIdInfo[] };
  audio_metadata?: { attendee_states?: AudioAttendeeState[] };
  audio_status?: { audio_status?: number };
  ping_pong?: { type?: string; ping_id?: number };
};

export const encodeFrame = (type: FrameTypeName, body: Record<string, unknown> = {}, now = Date.now()) => {
  const encoded = Frame.encode(Frame.fromObject({ timestamp_ms: now, type: frameTypes[type], ...body })).finish();
  // Every signaling message is one type byte and then the protobuf frame.
  const out = new Uint8Array(encoded.length + 1);
  out[0] = 0x05;
  out.set(encoded, 1);
  return out;
};

export const decodeFrame = (bytes: Uint8Array): SignalFrame =>
  Frame.toObject(Frame.decode(bytes.subarray(1)), { enums: String, longs: Number, bytes: String }) as SignalFrame;

export type SignalingLog = (level: "debug" | "info" | "warn", message: string, fields?: Record<string, unknown>) => void;

type FrameHandler = (frame: SignalFrame) => void;

/**
 * One signaling WebSocket to a Chime meeting. Answers the server's pings,
 * sends its own, and hands every decoded frame to its listeners. A new one is
 * opened for every (re)connect; the JoinToken can be reused.
 */
export class ChimeSignaling {
  private socket?: WebSocket;
  private handlers = new Set<FrameHandler>();
  private closeHandlers = new Set<(code: number, reason: string) => void>();
  private pingTimer?: NodeJS.Timeout;
  private pingId = 0;
  private closed = false;
  closeCode: number | undefined;
  lastInboundAt = Date.now();

  constructor(private signalingUrl: string, private joinToken: string, private log: SignalingLog) {}

  onFrame(handler: FrameHandler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onClose(handler: (code: number, reason: string) => void) {
    this.closeHandlers.add(handler);
  }

  connect(timeoutMs = 10_000) {
    const socket = new WebSocket(`${this.signalingUrl}?X-Chime-Control-Protocol-Version=3&X-Amzn-Chime-Send-Close-On-Error=1`, ["_aws_wt_session", this.joinToken]);
    this.socket = socket;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out opening Chime signaling"));
        socket.terminate();
      }, timeoutMs);
      socket.once("open", () => {
        clearTimeout(timer);
        this.lastInboundAt = Date.now();
        resolve();
      });
      socket.on("error", () => {
        clearTimeout(timer);
        reject(new Error("Chime signaling connection failed"));
      });
      socket.once("close", (code, reason) => {
        clearTimeout(timer);
        clearInterval(this.pingTimer);
        this.closeCode = code;
        if (this.closed) return;
        this.closed = true;
        for (const handler of this.closeHandlers) handler(code, reason.toString());
      });
      socket.on("message", (data) => this.receive(new Uint8Array(data as Buffer)));
    });
  }

  private receive(bytes: Uint8Array) {
    this.lastInboundAt = Date.now();
    let frame: SignalFrame;
    try {
      frame = decodeFrame(bytes);
    } catch {
      // Like the JS SDK, skip frames this proto cannot decode.
      this.log("debug", "Skipped an undecodable Chime signaling frame", { bytes: bytes.length });
      return;
    }
    if (frame.type === "PING_PONG" && frame.ping_pong?.type === "PING") this.send("PING_PONG", { ping_pong: { type: 2, ping_id: frame.ping_pong.ping_id } });
    for (const handler of this.handlers) handler(frame);
  }

  send(type: FrameTypeName, body: Record<string, unknown> = {}) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(encodeFrame(type, body));
    return true;
  }

  /** Resolves with the next frame of `type`; a different frame carrying an error rejects instead. */
  wait(type: string, timeoutMs = 15_000) {
    return new Promise<SignalFrame>((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        off();
      };
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for Chime ${type}`));
      }, timeoutMs);
      const off = this.onFrame((frame) => {
        if (frame.type === type) {
          stop();
          resolve(frame);
        } else if (frame.error && frame.type !== "PING_PONG") {
          stop();
          reject(new Error(`Chime ${frame.type} error ${frame.error.status}: ${frame.error.description ?? ""}`));
        }
      });
    });
  }

  join(audioSessionId: number) {
    this.send("JOIN", {
      join: {
        protocol_version: 2,
        flags: 2, // HAS_STREAM_UPDATE, needed for attendee presence
        client_details: {
          app_name: "Kevin",
          app_version: "1",
          device_model: process.platform,
          device_make: process.arch,
          platform_name: "Node",
          platform_version: process.version,
          client_source: "amazon-chime-sdk-js",
          chime_sdk_version: "3.31.0",
        },
        audio_session_id: audioSessionId,
        wants_compressed_sdp: false,
      },
    });
  }

  startPings(intervalMs = 10_000) {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.send("PING_PONG", { ping_pong: { type: 1, ping_id: ++this.pingId } }), intervalMs);
  }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    this.handlers.clear();
    try {
      this.socket?.close();
    } catch {
      // Already gone.
    }
  }
}
