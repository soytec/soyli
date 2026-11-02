/** Host-side observations only. Never return candidates, addresses, SDP or ICE credentials. */
export type PeerDiagnostics = {
  session: string;
  peer: string;
  state: RTCPeerConnectionState;
  route: 'direct' | 'relay' | 'unknown';
  rttMs: number | null;
  bufferedBytes: number;
  bytesSent: number;
  bytesReceived: number;
  messagesSent: number;
  messagesReceived: number;
};

export async function peerDiagnostics(
  session: string,
  peer: string,
  pc: RTCPeerConnection,
  channel?: RTCDataChannel,
): Promise<PeerDiagnostics> {
  const result: PeerDiagnostics = {
    session,
    peer,
    state: pc.connectionState,
    route: 'unknown',
    rttMs: null,
    bufferedBytes: channel?.bufferedAmount ?? 0,
    bytesSent: 0,
    bytesReceived: 0,
    messagesSent: 0,
    messagesReceived: 0,
  };
  try {
    const stats = await pc.getStats();
    const values = [...stats.values()];
    const transport = values.find((s) => s.type === 'transport' && s.selectedCandidatePairId);
    const pair = transport ? stats.get(transport.selectedCandidatePairId) : undefined;
    if (pair) {
      const local = stats.get(pair.localCandidateId),
        remote = stats.get(pair.remoteCandidateId);
      if (local?.candidateType && remote?.candidateType)
        result.route =
          local.candidateType === 'relay' || remote.candidateType === 'relay' ? 'relay' : 'direct';
      if (Number.isFinite(pair.currentRoundTripTime))
        result.rttMs = pair.currentRoundTripTime * 1000;
    }
    for (const data of values.filter((s) => s.type === 'data-channel')) {
      for (const key of ['bytesSent', 'bytesReceived', 'messagesSent', 'messagesReceived'] as const)
        if (Number.isFinite(data[key])) result[key] += data[key];
    }
  } catch {
    // A peer can close while getStats is in flight. This is an observation, not a game error.
  }
  return result;
}
