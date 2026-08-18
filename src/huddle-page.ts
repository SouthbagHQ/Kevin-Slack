import {
  AudioProfile,
  ConsoleLogger,
  DefaultActiveSpeakerPolicy,
  DefaultDeviceController,
  DefaultMeetingSession,
  LogLevel,
  MeetingSessionConfiguration,
} from "amazon-chime-sdk-js";

type Bootstrap = { meeting: Record<string, unknown>; attendee: Record<string, unknown>; silenceMs: number };

declare global {
  interface Window {
    __KEVIN_HUDDLE_BOOTSTRAP__: Bootstrap;
    __kevinHuddleAudio: (audio: { data: string; speakerId?: string }) => Promise<void>;
    __kevinHuddleStatus: (status: { type: string; error?: string }) => Promise<void>;
    kevinHuddle: { speak: (data: string) => Promise<void>; leave: () => Promise<void> };
  }
}

const bootstrap = window.__KEVIN_HUDDLE_BOOTSTRAP__;
const context = new AudioContext();
const microphone = context.createMediaStreamDestination();
const remoteAudio = document.createElement("audio");
remoteAudio.autoplay = true;
remoteAudio.muted = true;
document.body.append(remoteAudio);

const logger = new ConsoleLogger("KevinHuddle", LogLevel.WARN);
const session = new DefaultMeetingSession(
  new MeetingSessionConfiguration(bootstrap.meeting, bootstrap.attendee),
  logger,
  new DefaultDeviceController(logger),
);

const attendeeUsers = new Map<string, string>();
let activeSpeaker: string | undefined;
let monitorTimer: number | undefined;
let recorder: MediaRecorder | undefined;
let recordingStarted = 0;
let lastVoice = 0;
let recordingSpeaker: string | undefined;
let inboundReported = false;
let outboundReported = false;

const slackUserId = (external?: string) => external?.match(/(?:^|[:-])(U[A-Z0-9]+)(?:$|[:-])/)?.[1];

session.audioVideo.realtimeSubscribeToAttendeeIdPresence((attendeeId, present, externalUserId) => {
  if (!present) attendeeUsers.delete(attendeeId);
  else {
    const userId = slackUserId(externalUserId);
    if (userId) attendeeUsers.set(attendeeId, userId);
  }
});
session.audioVideo.subscribeToActiveSpeakerDetector(new DefaultActiveSpeakerPolicy(), ([attendeeId]) => {
  activeSpeaker = attendeeId ? attendeeUsers.get(attendeeId) : undefined;
});

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
};

const startRecording = (stream: MediaStream) => {
  const chunks: Blob[] = [];
  recordingStarted = Date.now();
  lastVoice = recordingStarted;
  recordingSpeaker = activeSpeaker;
  console.log(`[audio] voice detected${recordingSpeaker ? ` from ${recordingSpeaker}` : ""}`);
  recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
  recorder.addEventListener("dataavailable", ({ data }) => data.size && chunks.push(data));
  recorder.addEventListener("stop", async () => {
    const blob = new Blob(chunks, { type: "audio/webm" });
    const speakerId = recordingSpeaker;
    recorder = undefined;
    recordingSpeaker = undefined;
    if (blob.size < 1_000) return;
    console.log(`[audio] captured ${blob.size} bytes`);
    await window.__kevinHuddleAudio({ data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), speakerId });
  }, { once: true });
  recorder.start();
};

const monitor = (stream: MediaStream) => {
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  monitorTimer = window.setInterval(() => {
    analyser.getByteTimeDomainData(samples);
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length);
    const now = Date.now();
    if (rms > 0.018) {
      lastVoice = now;
      recordingSpeaker = activeSpeaker ?? recordingSpeaker;
      if (!recorder) startRecording(stream);
    }
    if (recorder?.state === "recording" && ((now - lastVoice > bootstrap.silenceMs && now - recordingStarted > 500) || now - recordingStarted > 14_000)) recorder.stop();
  }, 100);
};

const waitForRemoteStream = async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (remoteAudio.srcObject instanceof MediaStream && remoteAudio.srcObject.getAudioTracks().length) return remoteAudio.srcObject;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Chime did not provide remote audio");
};

session.audioVideo.addObserver({
  audioVideoDidStart: () => void waitForRemoteStream().then((stream) => {
    monitor(stream);
    return window.__kevinHuddleStatus({ type: "joined" });
  }).catch((error) => window.__kevinHuddleStatus({ type: "error", error: error instanceof Error ? error.message : String(error) })),
  audioVideoDidStop: (event) => void window.__kevinHuddleStatus({ type: "ended", error: String(event.statusCode()) }),
  metricsDidReceive: (report) => report.getRTCStatsReport().forEach((stat) => {
    if (stat.type !== "inbound-rtp" && stat.type !== "outbound-rtp" || stat.kind !== "audio" || !(stat.bytesReceived > 0 || stat.bytesSent > 0)) return;
    if (stat.type === "inbound-rtp" && !inboundReported) {
      inboundReported = true;
      console.log(`[audio] inbound RTP ${stat.bytesReceived} bytes`);
    }
    if (stat.type === "outbound-rtp" && !outboundReported) {
      outboundReported = true;
      console.log(`[audio] outbound RTP ${stat.bytesSent} bytes`);
    }
  }),
});

window.kevinHuddle = {
  async speak(data) {
    await context.resume();
    const binary = atob(data);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const buffer = await context.decodeAudioData(bytes.buffer);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(microphone);
    await new Promise<void>((resolve) => {
      source.addEventListener("ended", () => resolve(), { once: true });
      source.start();
    });
  },
  async leave() {
    if (monitorTimer) clearInterval(monitorTimer);
    if (recorder?.state === "recording") recorder.stop();
    session.audioVideo.stop();
    await session.audioVideo.stopAudioInput();
    session.audioVideo.unbindAudioElement();
    await context.close();
  },
};

await context.resume();
await session.audioVideo.bindAudioElement(remoteAudio);
session.audioVideo.setAudioProfile(AudioProfile.fullbandSpeechMono());
await session.audioVideo.startAudioInput(microphone.stream);
session.audioVideo.start();
session.audioVideo.realtimeUnmuteLocalAudio();
