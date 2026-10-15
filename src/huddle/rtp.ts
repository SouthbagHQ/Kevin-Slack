export const rtpPacket = (payloadType: number, sequence: number, timestamp: number, ssrc: number, payload: Uint8Array, marker = false) => {
  const packet = Buffer.alloc(12 + payload.length);
  packet[0] = 0x80;
  packet[1] = (marker ? 0x80 : 0) | payloadType;
  packet.writeUInt16BE(sequence & 0xffff, 2);
  packet.writeUInt32BE(timestamp >>> 0, 4);
  packet.writeUInt32BE(ssrc >>> 0, 8);
  packet.set(payload, 12);
  return packet;
};

/** An RTCP sender report with no report blocks. */
export const senderReport = (ssrc: number, rtpTimestamp: number, packets: number, octets: number, now = Date.now()) => {
  const packet = Buffer.alloc(28);
  packet[0] = 0x80;
  packet[1] = 200;
  packet.writeUInt16BE(6, 2);
  packet.writeUInt32BE(ssrc >>> 0, 4);
  const ntp = now / 1000 + 2_208_988_800;
  packet.writeUInt32BE(Math.floor(ntp) >>> 0, 8);
  packet.writeUInt32BE(Math.floor((ntp % 1) * 2 ** 32) >>> 0, 12);
  packet.writeUInt32BE(rtpTimestamp >>> 0, 16);
  packet.writeUInt32BE(packets >>> 0, 20);
  packet.writeUInt32BE(octets >>> 0, 24);
  return packet;
};

export const isRtcp = (packet: Uint8Array) => {
  const type = packet[1] ?? 0;
  return type >= 192 && type <= 223;
};

export type RtpPacket = { payloadType: number; sequence: number; timestamp: number; ssrc: number; payload: Uint8Array };

/** Reads an incoming RTP packet, skipping CSRCs, header extensions, and padding; undefined when it is not one. */
export const parseRtp = (packet: Uint8Array): RtpPacket | undefined => {
  if (packet.length < 12 || packet[0]! >> 6 !== 2 || isRtcp(packet)) return undefined;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  let offset = 12 + (packet[0]! & 0x0f) * 4;
  if (packet[0]! & 0x10) {
    if (offset + 4 > packet.length) return undefined;
    offset += 4 + view.getUint16(offset + 2) * 4;
  }
  let end = packet.length;
  if (packet[0]! & 0x20) end -= packet[packet.length - 1]!;
  if (offset > end) return undefined;
  return {
    payloadType: packet[1]! & 0x7f,
    sequence: view.getUint16(2),
    timestamp: view.getUint32(4),
    ssrc: view.getUint32(8),
    payload: packet.subarray(offset, end),
  };
};
