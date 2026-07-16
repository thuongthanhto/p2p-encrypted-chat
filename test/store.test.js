// Unit tests for the room store: ordering, dedup, sync-set computation.
import assert from 'node:assert/strict'

// minimal localStorage shim for Node
const backing = new Map()
globalThis.localStorage = {
  getItem: (k) => backing.get(k) ?? null,
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  key: (i) => [...backing.keys()][i] ?? null,
  get length() { return backing.size },
}

const {
  saltToRoomId, roomIdToSalt, createRoomState, loadRoom, saveRoom, forgetRoom,
  listRooms, addEntry, newEntry, maxSeqByAuthor, entriesMissingFor, mergeLog,
} = await import('../src/store.js')

// salt ↔ roomId roundtrip
const salt = Uint8Array.from({ length: 16 }, (_, i) => i * 7 % 256)
assert.deepEqual([...roomIdToSalt(saltToRoomId(salt))], [...salt])

// two devices in the same room, diverging while offline
const roomId = saltToRoomId(salt)
const a = createRoomState(roomId, 'fig-gift-dome-oak-71')
const b = createRoomState(roomId, 'fig-gift-dome-oak-71')
assert.notEqual(a.myId, b.myId)

const a1 = newEntry(a, 'chat', { text: 'hi from A' })
addEntry(a, a1)
const b1 = newEntry(b, 'chat', { text: 'hi from B' })
addEntry(b, b1)
const a2 = newEntry(a, 'chat', { text: 'offline msg from A' })
addEntry(a, a2)

// B tells A what it has; A computes what B is missing
const missingForB = entriesMissingFor(a, maxSeqByAuthor(b))
assert.deepEqual(missingForB.map((e) => e.id), [a1.id, a2.id])

// merge is idempotent and dedups
assert.equal(mergeLog(b, missingForB), 2)
assert.equal(mergeLog(b, missingForB), 0)
assert.equal(b.log.length, 3)

// after B merges, A only misses B's entry
assert.deepEqual(entriesMissingFor(b, maxSeqByAuthor(a)).map((e) => e.id), [b1.id])
assert.equal(mergeLog(a, [b1]), 1)

// both converge to identical ordered logs
assert.deepEqual(a.log.map((e) => e.id), b.log.map((e) => e.id))

// lamport clock advances past merged entries so new msgs sort after them
const a3 = newEntry(a, 'chat', { text: 'later' })
assert.ok(a3.lc > b1.lc && a3.lc > a2.lc)

// persistence roundtrip
saveRoom(a)
assert.deepEqual(loadRoom(roomId).log.map((e) => e.id), a.log.map((e) => e.id))
assert.equal(listRooms().length, 1)
forgetRoom(roomId)
assert.equal(loadRoom(roomId), null)

console.log('store tests: ALL PASS')
