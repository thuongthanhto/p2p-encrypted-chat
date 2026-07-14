# P2P Encrypted Chat — Lightweight

One HTML file. No server, no tracker, no account. Open it from `file://`, exchange
two codes by hand (Signal/Zalo/email), and chat 1-on-1 over a direct WebRTC
DataChannel with app-layer AES-GCM encryption.

Spec: [P2P_CHAT_LIGHTWEIGHT_SPEC.md](P2P_CHAT_LIGHTWEIGHT_SPEC.md)

## Usage

Send `dist/index.html` to both people. Then:

1. **A (host)**: open the file → *Create room* → gets a passphrase + **CODE-A**.
2. A sends the **passphrase** over one channel (read it out loud) and **CODE-A**
   over another (Signal/Zalo/email).
3. **B (guest)**: open the file → *Join room* → enter passphrase, paste CODE-A →
   gets **CODE-B** → sends it back to A.
4. A pastes CODE-B → *Connect* → chat.

Exchange the codes within a few minutes. Messages live in RAM only — closing the
tab erases everything. If the connection drops, start a new session.

## Crypto

```
passphrase (app-generated, 4 words + number)
  → PBKDF2-SHA256, 310k iters, random salt   (stretching — passphrase is low-entropy)
  → HKDF-SHA256
      ├─ info="sdp" → AES-GCM-256 key for the connection-code blobs (SDP contains IPs)
      └─ info="msg" → AES-GCM-256 key for chat messages (independent of WebRTC DTLS)
```

Code blob format: `magic(4) ‖ salt(16) ‖ iv(12) ‖ ciphertext`, deflate-compressed
before encryption, base64url-encoded (~600–700 chars).

Deviation from the spec: PBKDF2 was inserted before HKDF — HKDF alone is a single
hash and offers no brute-force resistance for a ~40-bit passphrase.

## Known trade-offs (by design)

- Manual signaling UX: two long strings per session, every session.
- No TURN by default → ~10–15% of network pairs (symmetric NAT, UDP-blocking
  firewalls) can't connect — in practice much worse for cross-country pairs where
  one side is behind CGNAT (common on Vietnamese ISPs). The app shows a clear
  failure message, and warns at code-creation time when STUN itself is blocked.
- No forward secrecy, no identity, no reconnect — see spec §6.

## TURN relay (for NATs that STUN can't traverse)

STUN-only traversal fails against symmetric NAT / CGNAT (common on Vietnamese
ISPs), which is fatal for cross-country pairs. The build embeds a TURN relay
from a [metered.ca](https://www.metered.ca/stun-turn) free account
(500MB/month, static credential) in `TURN_SERVERS` in [src/rtc.js](src/rtc.js),
including a `turns:…:443` variant that rides over TLS and works even where UDP
is fully blocked. WebRTC still prefers direct paths — the relay is only used
when nothing else connects. `node test/relay-e2e.js` proves a relay-only
session end-to-end; `node test/turn-check.js` and `node test/turn-allocate.js`
diagnose reachability and credentials.

To rotate the credential: create a new one
(`POST https://<app>.metered.live/api/v1/turn/credential?secretKey=…`), update
`src/rtc.js`, rebuild, resend the file.

Privacy note: a TURN relay forwards opaque bytes — traffic is DTLS-encrypted and
messages are additionally AES-GCM-encrypted at the app layer, so the relay sees
only IP addresses and traffic volume, never content. Text chat uses a few KB per
session, so the free quota is effectively unlimited for this use case. The
credential is embedded in the HTML file: anyone holding the file can consume the
relay quota, so share the file only with people you'd chat with, and regenerate
the credential if it leaks.

## Development

```sh
npm install
npm run dev          # local dev server
npm run build        # → dist/index.html (single file, ~16 kB)
npm run test:crypto  # crypto unit tests (Node)
npm run test:e2e     # full two-tab flow in headless Chrome (requires Chrome, macOS path)
```
