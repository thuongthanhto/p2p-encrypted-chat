// Non-trickle WebRTC: wait until ICE gathering is done before exporting the SDP,
// so each side only has to paste exactly one string.

const ICE_GATHER_TIMEOUT_MS = 5000

// STUN alone cannot traverse symmetric NAT / CGNAT (common on Vietnamese ISPs)
// or UDP-blocking firewalls. For those, add a TURN relay here and rebuild —
// free tiers: expressturn.com, metered.ca. The relay only ever sees
// double-encrypted bytes (DTLS + app-layer AES-GCM), plus IPs and volume.
// Example:
//   { urls: 'turn:relay1.expressturn.com:3478', username: '…', credential: '…' },
// Metered free tier (500MB/month): static credential, global anycast relay.
// turns:443 rides over TLS like normal HTTPS, so it also works on networks
// that block UDP entirely.
const TURN_SERVERS = [
  {
    urls: [
      'turn:global.relay.metered.ca:80',
      'turn:global.relay.metered.ca:80?transport=tcp',
      'turn:global.relay.metered.ca:443',
      'turns:global.relay.metered.ca:443?transport=tcp',
    ],
    username: '98774a62e08dd2195430b705',
    credential: 'sqS5eGaolyNtkdGR',
  },
]

export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.relay.metered.ca:80' },
  ...TURN_SERVERS,
]

export function createPeer() {
  return new RTCPeerConnection({ iceServers: ICE_SERVERS })
}

// Fallback timeout: if STUN is blocked (corporate networks), 'complete' can hang
// for a long time — better to export whatever candidates we have than freeze.
export function waitIceComplete(pc, timeoutMs = ICE_GATHER_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    const timer = setTimeout(done, timeoutMs)
    function done() {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    function check() {
      if (pc.iceGatheringState === 'complete') done()
    }
    pc.addEventListener('icegatheringstatechange', check)
  })
}

export function hasCandidates(sdp) {
  return sdp.includes('a=candidate:')
}

// srflx missing = STUN unreachable = this network blocks UDP to the internet;
// cross-network P2P will very likely fail (same-LAN may still work).
export function candidateSummary(sdp) {
  const types = [...sdp.matchAll(/a=candidate:.* typ (\w+)/g)].map((m) => m[1])
  return {
    host: types.filter((t) => t === 'host').length,
    srflx: types.filter((t) => t === 'srflx').length,
  }
}
