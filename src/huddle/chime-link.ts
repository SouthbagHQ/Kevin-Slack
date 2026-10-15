import nodeDataChannel from "node-datachannel";
import { isRtcp, parseRtp, rtpPacket, senderReport } from "./rtp.js";
import { ChimeSignaling, type SignalFrame, type SignalingLog, type TurnCredentials } from "./signaling.js";

// Ported from HuddleFM's native media backend (src/native-media/chime-link.ts), audio only.

const { PeerConnection, Audio, Video } = nodeDataChannel;
type Peer = InstanceType<typeof PeerConnection>;
type Track = ReturnType<Peer["addTrack"]>;

/** Why a Chime session ended, as amazon-chime-sdk-js MeetingSessionStatusCode values. */
export const statusCodes = {
  left: 1,
  joinedFromAnotherDevice: 2,
  authenticationRejected: 3,
  atCapacity: 4,
  meetingEnded: 5,
  signalingClosedUnexpectedly: 14,
  attendeeRemoved: 22,
  disconnectAudio: 25,
} as const;

// AUDIO_STATUS values that end the session instead of reconnecting.
const terminalAudioStatus: Record<number, number> = {
  301: statusCodes.joinedFromAnotherDevice,
  302: statusCodes.disconnectAudio,
  403: statusCodes.authenticationRejected,
  409: statusCodes.atCapacity,
  410: statusCodes.meetingEnded,
  411: statusCodes.attendeeRemoved,
};

const opusProfile = "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000";
const h264Profile = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f";
/** How long signaling may stay silent; the server sends BITRATES every 4 s. */
const silenceLimitMs = 15_000;
/** How long to keep retrying a lost connection before giving up. */
const reconnectWindowMs = 120_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type ChimeMeeting = { MediaPlacement: { SignalingUrl: string; AudioHostUrl: string } };
export type ChimeAttendee = { AttendeeId: string; JoinToken: string };

/** Chime said the session is over; reconnecting cannot help. */
class TerminalError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

type Connection = {
  signaling: ChimeSignaling;
  peer: Peer;
  audio: Track;
  // node-datachannel closes a native track when its wrapper is garbage collected.
  tracks: Track[];
  opusPayloadType: number;
  open: boolean;
  dead: boolean;
  reportTimer?: NodeJS.Timeout;
};

export type ChimeLinkEvents = {
  log: SignalingLog;
  /** A signaling session is starting; presence state built from earlier frames no longer applies. */
  onSignaling(): void;
  /** Every decoded signaling frame, for volume and presence. */
  onFrame(frame: SignalFrame): void;
  /** One Opus packet of the meeting's mixed audio (everyone but Kevin). */
  onAudio(payload: Uint8Array, sequence: number): void;
  /** A connection (first or reconnected) is carrying media. */
  onConnected(reconnect: boolean): void;
  /** The session cannot continue; `code` is one of statusCodes. */
  onTerminal(code: number, reason: string): void;
};

export const iceServers = (turn: TurnCredentials) => (turn.uris ?? []).flatMap((uri) => {
  const match = uri.match(/^(turns?):([^:?]+):(\d+)(?:\?transport=(\w+))?/);
  if (!match) return [];
  const [, scheme, hostname, port, transport] = match;
  return [{
    hostname: hostname!,
    port: Number(port),
    username: turn.username,
    password: turn.password,
    relayType: scheme === "turns" ? ("TurnTls" as const) : transport === "tcp" ? ("TurnTcp" as const) : ("TurnUdp" as const),
  }];
});

/**
 * Keeps Kevin connected to a Chime meeting as an attendee: signaling, a
 * relay-only WebRTC peer, Opus RTP out, and the mixed meeting audio in.
 * Rebuilds the connection with the same JoinToken when it drops, and gives up
 * after two minutes.
 */
export class ChimeLink {
  readonly attendeeId: string;
  private connection?: Connection;
  private stopping = false;
  private reconnecting?: Promise<void>;
  private watchdog?: NodeJS.Timeout;
  // One audio session and SSRC for the attendee's lifetime, so a reconnect continues the same stream.
  private audioSessionId = Math.floor(Math.random() * 2 ** 32);
  private audioSsrc = (Math.random() * 2 ** 31) >>> 0;
  private audioSequence = 0;
  private audioTimestamp = 0;
  readonly stats = { audioPackets: 0, audioBytes: 0, receivedPackets: 0, reconnects: 0 };

  constructor(private meeting: ChimeMeeting, private attendee: ChimeAttendee, private events: ChimeLinkEvents) {
    this.attendeeId = attendee.AttendeeId;
  }

  get connected() {
    return Boolean(this.connection?.open);
  }

  async start() {
    this.connection = await this.connect();
    this.watchdog = setInterval(() => this.checkSilence(), 1_000);
    this.events.onConnected(false);
  }

  /** Sends one Opus frame covering `samples` samples at 48 kHz. */
  sendAudio(payload: Uint8Array, samples = 960) {
    const connection = this.connection;
    const timestamp = this.audioTimestamp;
    this.audioTimestamp = (this.audioTimestamp + samples) >>> 0;
    const sequence = this.audioSequence++;
    if (!connection?.open) return false;
    const sent = this.write(connection.audio, rtpPacket(connection.opusPayloadType, sequence, timestamp, this.audioSsrc, payload));
    if (sent) {
      this.stats.audioPackets++;
      this.stats.audioBytes += payload.length;
    }
    return sent;
  }

  async leave(timeoutMs = 3_000) {
    this.stopping = true;
    clearInterval(this.watchdog);
    const connection = this.connection;
    this.connection = undefined;
    if (!connection) return;
    if (connection.signaling.send("LEAVE", { leave: {} })) await connection.signaling.wait("LEAVE_ACK", timeoutMs).catch(() => undefined);
    this.teardown(connection);
  }

  close() {
    this.stopping = true;
    clearInterval(this.watchdog);
    if (this.connection) this.teardown(this.connection);
    this.connection = undefined;
  }

  private write(track: Track, packet: Buffer) {
    try {
      return track.sendMessageBinary(packet);
    } catch {
      // A track throws once ICE or DTLS is gone; the watchdog reconnects.
      return false;
    }
  }

  private async connect(): Promise<Connection> {
    const signaling = new ChimeSignaling(this.meeting.MediaPlacement.SignalingUrl, this.attendee.JoinToken, this.events.log);
    let connection: Connection | undefined;
    let terminal: TerminalError | undefined;
    // Listen before joining: Chime lists the attendees already present once, right after JOIN.
    this.events.onSignaling();
    signaling.onFrame((frame) => this.events.onFrame(frame));
    signaling.onFrame((frame) => {
      const status = frame.audio_status?.audio_status;
      if (status !== undefined && terminalAudioStatus[status]) terminal ??= new TerminalError(terminalAudioStatus[status], `Chime audio status ${status}`);
    });
    try {
      await signaling.connect();
      signaling.join(this.audioSessionId);
      const ack = await signaling.wait("JOIN_ACK");
      const turn = ack.joinack?.turn_credentials;
      if (!turn?.uris?.length) throw new Error("Chime JOIN_ACK carried no TURN servers");
      await signaling.wait("INDEX", 5_000).catch(() => undefined);
      connection = this.createPeer(signaling, turn);
      await this.subscribe(connection);
      connection.open = true;
      this.watch(connection);
      return connection;
    } catch (error) {
      if (connection) this.teardown(connection);
      else signaling.close();
      if (signaling.closeCode === 4410) throw new TerminalError(statusCodes.meetingEnded, "Chime meeting ended");
      throw terminal ?? error;
    }
  }

  private createPeer(signaling: ChimeSignaling, turn: TurnCredentials): Connection {
    const peer = new PeerConnection("chime", { iceServers: iceServers(turn), iceTransportPolicy: "relay" });
    const audio = new Audio("0", "SendRecv");
    audio.addOpusCodec(111, opusProfile);
    audio.addSSRC(this.audioSsrc, "kevin", "kevin", "audio");
    const audioTrack = peer.addTrack(audio);
    // Like amazon-chime-sdk-js, always offer a video m-line; the server will not set up the session without one.
    const video = new Video("1", "Inactive");
    video.addH264Codec(102, h264Profile);
    const videoTrack = peer.addTrack(video);
    return { signaling, peer, audio: audioTrack, tracks: [audioTrack, videoTrack], opusPayloadType: 111, open: false, dead: false };
  }

  private async subscribe(connection: Connection) {
    const { peer, signaling } = connection;
    const gathered = new Promise<void>((resolve) => peer.onGatheringStateChange((state: string) => state === "complete" && resolve()));
    const opened = new Promise<void>((resolve) => {
      connection.audio.onOpen(resolve);
      peer.onStateChange((state: string) => state === "connected" && resolve());
    });
    peer.setLocalDescription();
    // Chime takes the whole offer at once; there is no trickle ICE.
    await Promise.race([gathered, sleep(10_000)]);
    const offer = peer.localDescription()!.sdp;
    if (!/typ relay/.test(offer)) throw new Error("No TURN relay candidate; Chime media is unreachable");
    signaling.send("SUBSCRIBE", {
      sub: {
        duplex: 1, // RX: audio only
        send_streams: [{
          media_type: 1,
          track_label: "AmazonChimeExpressAudio",
          stream_id: 1,
          group_id: 1,
          framerate: 15,
          max_bitrate_kbps: 600,
          avg_bitrate_bps: 400_000,
          attendee_id: this.attendeeId,
        }],
        receive_stream_ids: [0],
        // SDP.withUnifiedPlanFormat() in the JS SDK marks the offer this way.
        sdp_offer: offer.replace(/^o=\S+/m, "o=mozilla-chrome"),
        audio_host: this.meeting.MediaPlacement.AudioHostUrl,
        audio_checkin: false,
        audio_muted: false,
      },
    });
    const ack = await signaling.wait("SUBSCRIBE_ACK");
    const answer = ack.suback?.sdp_answer;
    if (!answer) throw new Error(`Chime refused SUBSCRIBE: ${ack.error?.status ?? "no answer"} ${ack.error?.description ?? ""}`);
    peer.setRemoteDescription(answer.split("\r\n").filter((line) => !/typ srflx/.test(line)).join("\r\n"), "answer");
    connection.opusPayloadType = Number(answer.match(/a=rtpmap:(\d+) opus\/48000/i)?.[1] ?? 111);
    await Promise.race([opened, sleep(15_000).then(() => {
      throw new Error("Chime media did not connect within 15 s");
    })]);
  }

  private watch(connection: Connection) {
    const { signaling, peer } = connection;
    signaling.onFrame((frame) => {
      const audioStatus = frame.audio_status?.audio_status;
      if (audioStatus !== undefined && terminalAudioStatus[audioStatus]) this.terminal(terminalAudioStatus[audioStatus], `Chime audio status ${audioStatus}`);
      else if (audioStatus !== undefined && audioStatus !== 200) this.lost(connection, `Chime audio status ${audioStatus}`);
    });
    signaling.onClose((code, reason) => {
      if (code === 4410) this.terminal(statusCodes.meetingEnded, "Chime meeting ended");
      else this.lost(connection, `signaling closed ${code} ${reason}`);
    });
    peer.onIceStateChange((state: string) => {
      if (state === "failed" || state === "closed") this.lost(connection, `ICE ${state}`);
    });
    peer.onStateChange((state: string) => {
      if (state === "failed" || state === "closed") this.lost(connection, `peer ${state}`);
    });
    connection.audio.onMessage((message: Buffer | string) => {
      if (typeof message === "string" || isRtcp(message)) return;
      const packet = parseRtp(message);
      if (!packet || packet.payloadType !== connection.opusPayloadType || !packet.payload.length) return;
      this.stats.receivedPackets++;
      this.events.onAudio(packet.payload, packet.sequence);
    });
    signaling.startPings();
    connection.reportTimer = setInterval(() => {
      if (connection.open) this.write(connection.audio, senderReport(this.audioSsrc, this.audioTimestamp, this.stats.audioPackets, this.stats.audioBytes));
    }, 1_000);
  }

  private checkSilence() {
    const connection = this.connection;
    if (!connection?.open) return;
    const silentMs = Date.now() - connection.signaling.lastInboundAt;
    if (silentMs > silenceLimitMs) this.lost(connection, `no signaling for ${silentMs} ms`);
  }

  private teardown(connection: Connection) {
    connection.dead = true;
    connection.open = false;
    clearInterval(connection.reportTimer);
    connection.signaling.close();
    try {
      connection.peer.close();
    } catch {
      // Already closed.
    }
  }

  private terminal(code: number, reason: string) {
    if (this.stopping) return;
    this.close();
    this.events.onTerminal(code, reason);
  }

  private lost(connection: Connection, reason: string) {
    if (connection.dead || this.stopping) return;
    this.events.log("warn", "Chime connection lost", { reason });
    this.teardown(connection);
    if (this.connection === connection) this.connection = undefined;
    this.reconnecting ??= this.reconnect().finally(() => {
      this.reconnecting = undefined;
    });
  }

  private async reconnect() {
    const startedAt = Date.now();
    for (let attempt = 1; !this.stopping; attempt++) {
      try {
        const connection = await this.connect();
        if (this.stopping) {
          this.teardown(connection);
          return;
        }
        this.connection = connection;
        this.stats.reconnects++;
        this.events.log("info", "Chime reconnected", { attempt, ms: Date.now() - startedAt });
        this.events.onConnected(true);
        return;
      } catch (error) {
        if (error instanceof TerminalError) {
          this.terminal(error.code, error.message);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.events.log("warn", "Chime reconnect attempt failed", { attempt, error: message });
        if (Date.now() - startedAt > reconnectWindowMs) {
          this.terminal(statusCodes.signalingClosedUnexpectedly, `Could not reconnect to Chime: ${message}`);
          return;
        }
        await sleep(Math.min(8_000, 1_000 * 2 ** (attempt - 1)));
      }
    }
  }
}
