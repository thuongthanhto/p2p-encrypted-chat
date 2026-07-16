import './style.css'
import {
  generatePassphrase, randomSalt, deriveKeys,
  sealSdp, parseBlob, openSdp, encryptJson, decryptJson, cleanBlob,
  sealExport, parseExportBlob, openExport,
} from './crypto.js'
import { createPeer, waitIceComplete, hasCandidates, candidateSummary } from './rtc.js'
import {
  saltToRoomId, roomIdToSalt, createRoomState, loadRoom, saveRoom, forgetRoom,
  listRooms, addEntry, newEntry, maxSeqByAuthor, entriesMissingFor, mergeLog,
} from './store.js'
import { createBoard } from './board.js'

const $ = (id) => document.getElementById(id)
const screens = ['screen-home', 'screen-host', 'screen-join', 'screen-chat']

let pc = null
let dc = null
let keys = null
let room = null
let peerSynced = false // becomes true after the first hello exchange this session

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

function roomLabel(r) {
  return r.passphrase.split('-').slice(0, 2).join('-') + '-…'
}

function stunWarning(summary) {
  return summary.srflx === 0
    ? ' · ⚠️ STUN unreachable: this network blocks UDP; the TURN relay will carry the traffic if a direct path fails'
    : ''
}

// ---- Copy buttons -----------------------------------------------------------

for (const btn of document.querySelectorAll('button.copy')) {
  btn.addEventListener('click', async () => {
    const el = $(btn.dataset.copy)
    const text = el.value ?? el.textContent
    try {
      await navigator.clipboard.writeText(text)
    } catch {
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

for (const btn of document.querySelectorAll('button.back')) {
  btn.addEventListener('click', () => {
    teardownPeer()
    renderHome()
  })
}

// ---- Home / room list -------------------------------------------------------

function renderHome() {
  const list = $('room-list')
  list.textContent = ''
  for (const r of listRooms()) {
    const card = document.createElement('div')
    card.className = 'room-card'
    const name = document.createElement('span')
    name.className = 'room-name'
    name.textContent = roomLabel(r)
    card.appendChild(name)
    for (const [label, action] of [
      ['Open', 'open'], ['Create code', 'host'], ['Paste code', 'join'], ['Forget', 'forget'],
    ]) {
      const b = document.createElement('button')
      b.className = 'mini' + (action === 'forget' ? ' danger' : '')
      b.textContent = label
      b.addEventListener('click', () => roomAction(action, r.id))
      card.appendChild(b)
    }
    list.appendChild(card)
  }
  show('screen-home')
}

async function roomAction(action, roomId) {
  const r = loadRoom(roomId)
  if (!r) return renderHome()
  if (action === 'forget') {
    if (confirm(`Forget room ${roomLabel(r)}? History on this device is erased. The backup file, if you made one, still works.`)) {
      forgetRoom(roomId)
      renderHome()
    }
    return
  }
  room = r
  // join derives its keys from the pasted CODE-A later; open/export and
  // rejoin-hosting need them now
  if (action !== 'join') keys = await deriveKeys(room.passphrase, roomIdToSalt(room.id))
  if (action === 'open') enterChat()
  if (action === 'host') startHost(true)
  if (action === 'join') startJoin(true)
}

// ---- Host flow --------------------------------------------------------------

$('btn-host').addEventListener('click', () => startHost(false))

async function startHost(rejoin) {
  show('screen-host')
  $('host-title').textContent = rejoin ? `Reconnect · ${roomLabel(room)}` : 'Create room'
  $('host-offer').value = ''
  $('host-answer').value = ''
  setError($('host-error'), '')
  const statusEl = $('host-status')
  try {
    if (!rejoin) {
      const passphrase = generatePassphrase()
      const salt = randomSalt()
      keys = await deriveKeys(passphrase, salt)
      room = createRoomState(saltToRoomId(salt), passphrase)
      saveRoom(room)
    }
    $('host-pass').textContent = room.passphrase

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
    const summary = candidateSummary(sdp)
    console.log('[p2p] candidates:', JSON.stringify(summary))
    $('host-offer').value = await sealSdp(sdp, keys.sdpKey, keys.salt)
    setStatus(statusEl, 'waiting for CODE-B… — exchange codes within a few minutes' + stunWarning(summary))
  } catch (err) {
    setError($('host-error'), errorMessage(err))
  }
}

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

$('btn-join').addEventListener('click', () => startJoin(false))

function startJoin(rejoin) {
  show('screen-join')
  $('join-title').textContent = rejoin ? `Reconnect · ${roomLabel(room)}` : 'Join room'
  $('join-pass').value = rejoin ? room.passphrase : ''
  $('join-offer').value = ''
  $('join-answer').value = ''
  setError($('join-error'), '')
  setStatus($('join-status'), '')
  if (!rejoin) $('join-pass').focus()
}

$('btn-join-answer').addEventListener('click', async () => {
  const statusEl = $('join-status')
  setError($('join-error'), '')
  try {
    const passphrase = $('join-pass').value
    if (!passphrase.trim()) throw new Error('Passphrase is empty')
    const blob = parseBlob($('join-offer').value)
    keys = await deriveKeys(passphrase, blob.salt)
    const offerSdp = await openSdp(blob, keys.sdpKey)

    // same salt → same room id on both devices; reuse local history if present
    const roomId = saltToRoomId(blob.salt)
    room = loadRoom(roomId) || createRoomState(roomId, passphrase.trim())
    saveRoom(room)

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
    const summary = candidateSummary(sdp)
    console.log('[p2p] candidates:', JSON.stringify(summary))
    $('join-answer').value = await sealSdp(sdp, keys.sdpKey, keys.salt)
    setStatus(statusEl, 'send CODE-B to the other side, then wait for the connection…' + stunWarning(summary))
  } catch (err) {
    setError($('join-error'), errorMessage(err))
  }
})

for (const id of ['host-answer', 'join-offer']) {
  $(id).addEventListener('paste', () => {
    setTimeout(() => { $(id).value = cleanBlob($(id).value) }, 0)
  })
}

// ---- Peer wiring ------------------------------------------------------------

// matches Chrome's ~30s ICE consent timeout — a true death still fails fast
// via the 'failed' state; this only pads transient 'disconnected' blips
const RECOVER_GRACE_MS = 30000
let disconnectTimer = null

function showBanner(text) {
  $('banner-text').textContent = text
  $('banner').hidden = false
}

function setConnectedUi(connected) {
  $('chat-state').classList.toggle('off', !connected)
  if (connected) $('banner').hidden = true
}

function fatalDisconnect() {
  clearTimeout(disconnectTimer)
  peerSynced = false
  setConnectedUi(false)
  showBanner('Disconnected — messages you send now are queued and delivered next session.')
}

function teardownPeer() {
  clearTimeout(disconnectTimer)
  clearInterval(heartbeatTimer)
  try { dc?.close() } catch {}
  try { pc?.close() } catch {}
  dc = null
  pc = null
  peerSynced = false
}

function wirePeer(statusEl) {
  window.__pc = pc
  pc.addEventListener('iceconnectionstatechange', () =>
    console.log(`[p2p] ice: ${pc.iceConnectionState} @${new Date().toISOString()}`))
  pc.addEventListener('connectionstatechange', () => {
    const st = pc.connectionState
    console.log(`[p2p] connection: ${st} @${new Date().toISOString()}`)
    if (st === 'connecting') setStatus(statusEl, 'connecting…')
    if (st === 'connected') {
      setStatus(statusEl, 'connected ✓')
      clearTimeout(disconnectTimer)
      disconnectTimer = null
      setConnectedUi(true)
    }
    if (st === 'disconnected') {
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
          'Could not connect — the two networks failed to reach each other. Try again, or from a different network.')
      }
    }
  })
}

const HEARTBEAT_MS = 10000
let heartbeatTimer = null

function wireChannel(channel) {
  dc = channel
  dc.binaryType = 'arraybuffer'
  dc.addEventListener('open', async () => {
    enterChat()
    setConnectedUi(true)
    clearInterval(heartbeatTimer)
    heartbeatTimer = setInterval(() => {
      if (dc.readyState === 'open') dc.send(Uint8Array.of(0))
    }, HEARTBEAT_MS)
    await sendJson({ k: 'hello', have: maxSeqByAuthor(room) })
  })
  dc.addEventListener('message', onWireMessage)
  dc.addEventListener('close', () => {
    clearInterval(heartbeatTimer)
    if (!$('screen-chat').hidden) fatalDisconnect()
  })
}

async function sendJson(obj) {
  if (dc?.readyState !== 'open') return
  try {
    dc.send(await encryptJson(obj, keys.msgKey))
  } catch {
    // channel died mid-send — the entry is already in the log, sync covers it
  }
}

async function onWireMessage(e) {
  if (e.data.byteLength <= 1) return // heartbeat
  let msg
  try {
    msg = await decryptJson(e.data, keys.msgKey)
  } catch {
    appendSysMsg('⚠️ Received a message that could not be decrypted')
    return
  }
  if (msg.k === 'hello') {
    // send whatever the peer is missing, then it does the same for us
    const missing = entriesMissingFor(room, msg.have || {})
    await sendJson({ k: 'sync', entries: missing })
    if (!peerSynced) {
      peerSynced = true
      await sendJson({ k: 'hello', have: maxSeqByAuthor(room) })
    }
  }
  if (msg.k === 'sync') {
    if (mergeLog(room, msg.entries || []) > 0) {
      saveRoom(room)
      renderLog()
    }
  }
  if (msg.k === 'entry') {
    if (addEntry(room, msg.e)) {
      saveRoom(room)
      if (msg.e.t === 'chat') renderChatEntry(msg.e)
      else boardApi.redraw(room.log)
    }
  }
}

// create a log entry locally and push it to the peer if connected
async function commitEntry(type, payload) {
  const entry = newEntry(room, type, payload)
  addEntry(room, entry)
  saveRoom(room)
  await sendJson({ k: 'entry', e: entry })
  return entry
}

// ---- Chat screen ------------------------------------------------------------

function enterChat() {
  $('room-label').textContent = roomLabel(room)
  window.__room = room
  show('screen-chat')
  if (!dc || dc.readyState !== 'open') {
    setConnectedUi(false)
    showBanner('Not connected — messages you send now are queued and delivered next session.')
  }
  renderLog()
  $('msg-input').focus()
}

function renderLog() {
  const ul = $('messages')
  ul.textContent = ''
  for (const e of room.log) if (e.t === 'chat') renderChatEntry(e)
  boardApi.redraw(room.log)
}

function renderChatEntry(e) {
  const li = document.createElement('li')
  li.className = e.from === room.myId ? 'me' : 'them'
  li.textContent = e.text
  $('messages').appendChild(li)
  li.scrollIntoView({ block: 'end' })
}

function appendSysMsg(text) {
  const li = document.createElement('li')
  li.className = 'sys'
  li.textContent = text
  $('messages').appendChild(li)
}

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault()
  const input = $('msg-input')
  const text = input.value.trim()
  if (!text) return
  const entry = await commitEntry('chat', { text })
  renderChatEntry(entry)
  input.value = ''
})

$('btn-reconnect').addEventListener('click', () => {
  teardownPeer()
  renderHome()
})

$('btn-leave').addEventListener('click', () => {
  teardownPeer()
  renderHome()
})

// ---- Tabs -------------------------------------------------------------------

function selectTab(draw) {
  $('chat-panel').hidden = draw
  $('draw-panel').hidden = !draw
  $('btn-tab-chat').classList.toggle('active', !draw)
  $('btn-tab-draw').classList.toggle('active', draw)
  if (draw) boardApi.redraw(room.log)
}
$('btn-tab-chat').addEventListener('click', () => selectTab(false))
$('btn-tab-draw').addEventListener('click', () => selectTab(true))

// ---- Whiteboard -------------------------------------------------------------

let brushColor = '#e8ecf4'
for (const sw of document.querySelectorAll('.swatch')) {
  sw.addEventListener('click', () => {
    document.querySelector('.swatch.active')?.classList.remove('active')
    sw.classList.add('active')
    brushColor = sw.dataset.color
  })
}

const boardApi = createBoard($('board'), {
  getColor: () => brushColor,
  getWidth: () => Number($('stroke-width').value),
  onStroke: (stroke) => commitEntry('draw', { s: stroke }),
})

$('btn-wipe').addEventListener('click', async () => {
  await commitEntry('wipe', {})
  boardApi.redraw(room.log)
})

// ---- Backup / restore -------------------------------------------------------

$('btn-export').addEventListener('click', async () => {
  const blob = await sealExport(
    { v: 1, log: room.log }, keys.exportKey, roomIdToSalt(room.id))
  const file = new Blob([blob], { type: 'application/octet-stream' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(file)
  a.download = `${roomLabel(room).replace('…', 'room')}-${new Date().toISOString().slice(0, 10)}.p2pchat`
  a.click()
  URL.revokeObjectURL(a.href)
})

$('btn-restore').addEventListener('click', () => {
  $('restore-panel').hidden = !$('restore-panel').hidden
})

$('btn-restore-go').addEventListener('click', async () => {
  setError($('restore-error'), '')
  try {
    const file = $('restore-file').files[0]
    const passphrase = $('restore-pass').value.trim()
    if (!file || !passphrase) throw new Error('Pick the backup file and enter its passphrase')
    const parsed = parseExportBlob(await file.text())
    const restoreKeys = await deriveKeys(passphrase, parsed.salt)
    const data = await openExport(parsed, restoreKeys.exportKey)

    const roomId = saltToRoomId(parsed.salt)
    const target = loadRoom(roomId) || createRoomState(roomId, passphrase)
    mergeLog(target, data.log || [])
    saveRoom(target)
    $('restore-file').value = ''
    $('restore-pass').value = ''
    $('restore-panel').hidden = true
    renderHome()
  } catch (err) {
    setError($('restore-error'), errorMessage(err))
  }
})

// ---- Boot -------------------------------------------------------------------

renderHome()
