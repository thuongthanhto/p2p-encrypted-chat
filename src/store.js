// Room persistence in localStorage. A "room" is identified by its key-derivation
// salt (base64url) — both sides converge on the same id because the guest learns
// the salt from CODE-A. History lives on the device until the room is forgotten;
// the encrypted artifact is the backup file, not local storage (the passphrase
// is stored right next to it, so encrypting locally would be theater).

const PREFIX = 'p2pchat.room.'

export function saltToRoomId(saltBytes) {
  let bin = ''
  for (const b of saltBytes) bin += String.fromCharCode(b)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function roomIdToSalt(roomId) {
  const bin = atob(roomId.replaceAll('-', '+').replaceAll('_', '/'))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

export function createRoomState(roomId, passphrase) {
  return {
    id: roomId,
    passphrase,
    myId: crypto.randomUUID().slice(0, 8),
    seq: 0,   // my per-author message counter
    lc: 0,    // lamport clock for cross-device ordering
    log: [],
    updated: 0,
  }
}

export function loadRoom(roomId) {
  try {
    return JSON.parse(localStorage.getItem(PREFIX + roomId))
  } catch {
    return null
  }
}

export function saveRoom(room) {
  room.updated = Date.now()
  localStorage.setItem(PREFIX + room.id, JSON.stringify(room))
}

export function forgetRoom(roomId) {
  localStorage.removeItem(PREFIX + roomId)
}

export function listRooms() {
  const rooms = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith(PREFIX)) continue
    const room = loadRoom(key.slice(PREFIX.length))
    if (room?.id) rooms.push(room)
  }
  return rooms.sort((a, b) => (b.updated || 0) - (a.updated || 0))
}

function logOrder(a, b) {
  return (a.lc - b.lc) || a.from.localeCompare(b.from) || (a.seq - b.seq)
}

// Insert an entry unless already present; keeps the log ordered and the
// lamport clock monotonic. Returns true if the entry was new.
export function addEntry(room, entry) {
  if (room.log.some((e) => e.id === entry.id)) return false
  room.log.push(entry)
  room.lc = Math.max(room.lc, entry.lc || 0)
  room.log.sort(logOrder)
  return true
}

export function newEntry(room, type, payload) {
  room.seq += 1
  room.lc += 1
  return {
    id: `${room.myId}:${room.seq}`,
    from: room.myId,
    seq: room.seq,
    lc: room.lc,
    ts: Date.now(),
    t: type,
    ...payload,
  }
}

// {authorId: highest seq held} — the "vector clock" both sides trade on connect
export function maxSeqByAuthor(room) {
  const have = {}
  for (const e of room.log) have[e.from] = Math.max(have[e.from] || 0, e.seq)
  return have
}

// entries the peer is missing given the `have` map it sent us
export function entriesMissingFor(room, have) {
  return room.log.filter((e) => e.seq > (have[e.from] || 0))
}

export function mergeLog(room, entries) {
  let added = 0
  for (const e of entries) if (addEntry(room, e)) added += 1
  return added
}
