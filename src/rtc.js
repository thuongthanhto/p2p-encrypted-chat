// Non-trickle WebRTC: wait until ICE gathering is done before exporting the SDP,
// so each side only has to paste exactly one string.

const ICE_GATHER_TIMEOUT_MS = 5000

export function createPeer() {
  return new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  })
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
