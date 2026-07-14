import './style.css'
import {
  generatePassphrase, randomSalt, deriveKeys,
  sealSdp, parseBlob, openSdp, encryptMsg, decryptMsg, cleanBlob,
} from './crypto.js'
import { createPeer, waitIceComplete, hasCandidates } from './rtc.js'

const $ = (id) => document.getElementById(id)
const screens = ['screen-home', 'screen-host', 'screen-join', 'screen-chat']

let pc = null
let dc = null
let keys = null

function show(id) {
  for (const s of screens) $(s).hidden = s !== id
}

function setStatus(el, text) {
  el.textContent = text
}

function setError(el, text) {
  el.hidden = !text
  el.textContent = text || ''
}

function errorMessage(err) {
  if (err?.message === 'BAD_FORMAT') return 'The code is malformed — copy it again in full and retry.'
  if (err?.message === 'BAD_KEY') return 'Wrong passphrase or corrupted code — double-check both.'
  return `Error: ${err?.message || err}`
}

// ---- Copy buttons -----------------------------------------------------------

for (const btn of document.querySelectorAll('button.copy')) {
  btn.addEventListener('click', async () => {
    const el = $(btn.dataset.copy)
    const text = el.value ?? el.textContent
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // fallback if the Clipboard API is blocked
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    const old = btn.textContent
    btn.textContent = 'Copied ✓'
    setTimeout(() => { btn.textContent = old }, 1500)
  })
}

// ---- Peer wiring ------------------------------------------------------------

// matches Chrome's ~30s ICE consent timeout — a true death still fails fast
// via the 'failed' state; this only pads transient 'disconnected' blips
const RECOVER_GRACE_MS = 30000
let disconnectTimer = null

function showBanner(text) {
  $('banner').firstChild.textContent = text + ' '
  $('banner').hidden = false
}

function fatalDisconnect() {
  clearTimeout(disconnectTimer)
  showBanner('Connection lost — a new session is needed.')
  $('msg-input').disabled = true
}

function wirePeer(statusEl) {
  // debug hooks: open DevTools console to trace why a session dropped
  window.__pc = pc
  pc.addEventListener('iceconnectionstatechange', () =>
    console.log(`[p2p] ice: ${pc.iceConnectionState} @${new Date().toISOString()}`))
  pc.addEventListener('connectionstatechange', () => {
    const st = pc.connectionState
    console.log(`[p2p] connection: ${st} @${new Date().toISOString()}`)
    if (st === 'connecting') setStatus(statusEl, 'connecting…')
    if (st === 'connected') {
      setStatus(statusEl, 'connected ✓')
      // recovered from a transient drop
      clearTimeout(disconnectTimer)
      disconnectTimer = null
      if (!$('msg-input').disabled) $('banner').hidden = true
    }
    if (st === 'disconnected') {
      // usually transient (Wi-Fi blip, network switch) — give it a grace period
      if (!$('screen-chat').hidden) {
        showBanner('Connection unstable — trying to recover…')
        clearTimeout(disconnectTimer)
        disconnectTimer = setTimeout(fatalDisconnect, RECOVER_GRACE_MS)
      }
    }
    if (st === 'failed' || st === 'closed') {
      if (!$('screen-chat').hidden) {
        fatalDisconnect()
      } else {
        setStatus(statusEl, '')
        setError(statusEl.nextElementSibling,
          'Could not connect — the two networks failed to reach each other (NAT blocked). Try a different network or a phone hotspot.')
      }
    }
  })
}

const HEARTBEAT_MS = 10000
let heartbeatTimer = null

function wireChannel(channel) {
  dc = channel
  dc.binaryType = 'arraybuffer'
  dc.addEventListener('open', () => {
    show('screen-chat')
    $('msg-input').focus()
    // 1-byte ping keeps NAT/firewall UDP bindings warm while the chat sits idle
    clearInterval(heartbeatTimer)
    heartbeatTimer = setInterval(() => {
      if (dc.readyState === 'open') dc.send(Uint8Array.of(0))
    }, HEARTBEAT_MS)
  })
  dc.addEventListener('message', async (e) => {
    if (e.data.byteLength <= 1) return // heartbeat ping
    try {
      appendMsg(await decryptMsg(e.data, keys.msgKey), 'them')
    } catch {
      appendMsg('⚠️ Received a message that could not be decrypted', 'sys')
    }
  })
  dc.addEventListener('close', () => {
    clearInterval(heartbeatTimer)
    fatalDisconnect()
  })
}

function appendMsg(text, who) {
  const li = document.createElement('li')
  li.className = who
  li.textContent = text
  $('messages').appendChild(li)
  li.scrollIntoView({ block: 'end' })
}

// ---- Host flow --------------------------------------------------------------

$('btn-host').addEventListener('click', async () => {
  show('screen-host')
  const statusEl = $('host-status')
  try {
    const passphrase = generatePassphrase()
    $('host-pass').textContent = passphrase
    keys = await deriveKeys(passphrase, randomSalt())

    pc = createPeer()
    wirePeer(statusEl)
    wireChannel(pc.createDataChannel('chat'))

    setStatus(statusEl, 'gathering network addresses…')
    await pc.setLocalDescription(await pc.createOffer())
    await waitIceComplete(pc)

    const sdp = pc.localDescription.sdp
    if (!hasCandidates(sdp)) {
      setError($('host-error'), 'No network addresses gathered — check your connection and try again.')
      return
    }
    $('host-offer').value = await sealSdp(sdp, keys.sdpKey, keys.salt)
    setStatus(statusEl, 'waiting for CODE-B… — exchange codes within a few minutes; waiting too long can break the session')
  } catch (err) {
    setError($('host-error'), errorMessage(err))
  }
})

$('btn-host-connect').addEventListener('click', async () => {
  const statusEl = $('host-status')
  setError($('host-error'), '')
  try {
    const blob = parseBlob($('host-answer').value)
    const sdp = await openSdp(blob, keys.sdpKey)
    setStatus(statusEl, 'connecting…')
    await pc.setRemoteDescription({ type: 'answer', sdp })
  } catch (err) {
    setError($('host-error'), errorMessage(err))
  }
})

// ---- Guest flow -------------------------------------------------------------

$('btn-join').addEventListener('click', () => {
  show('screen-join')
  $('join-pass').focus()
})

$('btn-join-answer').addEventListener('click', async () => {
  const statusEl = $('join-status')
  setError($('join-error'), '')
  try {
    const passphrase = $('join-pass').value
    if (!passphrase.trim()) throw new Error('Passphrase is empty')
    const blob = parseBlob($('join-offer').value)
    keys = await deriveKeys(passphrase, blob.salt)
    const offerSdp = await openSdp(blob, keys.sdpKey)

    pc = createPeer()
    wirePeer(statusEl)
    pc.addEventListener('datachannel', (e) => wireChannel(e.channel))

    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
    setStatus(statusEl, 'gathering network addresses…')
    await pc.setLocalDescription(await pc.createAnswer())
    await waitIceComplete(pc)

    const sdp = pc.localDescription.sdp
    if (!hasCandidates(sdp)) {
      setError($('join-error'), 'No network addresses gathered — check your connection and try again.')
      return
    }
    $('join-answer').value = await sealSdp(sdp, keys.sdpKey, keys.salt)
    setStatus(statusEl, 'send CODE-B to the other side, then wait for the connection…')
  } catch (err) {
    setError($('join-error'), errorMessage(err))
  }
})

// Messengers add stray whitespace — clean right after paste
for (const id of ['host-answer', 'join-offer']) {
  $(id).addEventListener('paste', () => {
    setTimeout(() => { $(id).value = cleanBlob($(id).value) }, 0)
  })
}

// ---- Chat -------------------------------------------------------------------

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault()
  const input = $('msg-input')
  const text = input.value.trim()
  if (!text || !dc || dc.readyState !== 'open') return
  dc.send(await encryptMsg(text, keys.msgKey))
  appendMsg(text, 'me')
  input.value = ''
})

$('btn-restart').addEventListener('click', () => location.reload())
