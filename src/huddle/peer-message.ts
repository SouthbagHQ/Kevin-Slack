import protobuf from "protobufjs";

/**
 * The parts of Slack's `calls/client/peer_message.proto` Kevin uses. Slack's
 * huddle clients exchange these as Chime data messages on the `data-channel`
 * topic; field numbers match the descriptor embedded in Slack's web client
 * (see github.com/ingoau/slack-huddle-playground).
 */
const root = protobuf.parse(`
syntax = "proto3";
message PeerMessage {
  message MuteRequest { string peerId = 1; }
  string fromPeerIdString = 4;
  MuteRequest muteRequest = 10;
}
`, { keepCase: true }).root;
const PeerMessage = root.lookupType("PeerMessage");

/** Chime's data message topic for every PeerMessage Slack's clients exchange. */
export const PEER_TOPIC = "data-channel";

/** Asks the client of attendee `peerId` to mute its microphone; Slack's clients honour it from any participant. */
export const muteRequest = (peerId: string, fromPeerId: string) =>
  PeerMessage.encode(PeerMessage.fromObject({ muteRequest: { peerId }, fromPeerIdString: fromPeerId })).finish();

export const decodePeerMessage = (bytes: Uint8Array) =>
  PeerMessage.toObject(PeerMessage.decode(bytes)) as { fromPeerIdString?: string; muteRequest?: { peerId?: string } };
