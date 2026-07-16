// App-layer crypto: passphrase → PBKDF2 (the passphrase is low-entropy, so stretch
// it against offline brute-force) → HKDF splits into two AES-GCM-256 keys:
// "sdp" for the connection-code blob, "msg" for chat messages.
// Independent of WebRTC's own DTLS layer.
import { WORDS } from './words.js'

const te = new TextEncoder()
const td = new TextDecoder()

// Blob layout: MAGIC(4) ‖ salt(16) ‖ iv(12) ‖ ciphertext, base64url-encoded.
const MAGIC = Uint8Array.of(0x50, 0x32, 0x43, 0x31) // "P2C1" — connection codes
const MAGIC_EXPORT = Uint8Array.of(0x50, 0x32, 0x45, 0x31) // "P2E1" — backup files
const SALT_LEN = 16
const IV_LEN = 12
const PBKDF2_ITERS = 310_000

function randInt(max) {
  // rejection sampling to avoid modulo bias
  const limit = Math.floor(0xffffffff / max) * max
  const buf = new Uint32Array(1)
  do crypto.getRandomValues(buf); while (buf[0] >= limit)
  return buf[0] % max
}

export function generatePassphrase() {
  const words = Array.from({ length: 4 }, () => WORDS[randInt(WORDS.length)])
  return `${words.join('-')}-${10 + randInt(90)}`
}

export function randomSalt() {
  return crypto.getRandomValues(new Uint8Array(SALT_LEN))
}

// Normalize so the same passphrase typed on macOS (NFD) and Windows/Android (NFC)
// derives the same key.
function normalizePass(passphrase) {
  return passphrase.trim().normalize('NFC')
}

export async function deriveKeys(passphrase, salt) {
  const base = await crypto.subtle.importKey(
    'raw', te.encode(normalizePass(passphrase)), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERS }, base, 256)
  const master = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  const sub = (info) => crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) },
    master, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  return {
    sdpKey: await sub('sdp'),
    msgKey: await sub('msg'),
    exportKey: await sub('export'),
    salt,
  }
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function toB64url(bytes) {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromB64url(str) {
  const bin = atob(str.replaceAll('-', '+').replaceAll('_', '/'))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

// Messengers tend to inject whitespace, line breaks, or trailing punctuation
// into long strings — strip everything outside the base64url alphabet.
export function cleanBlob(str) {
  return str.replace(/[^A-Za-z0-9_-]/g, '')
}

export async function sealSdp(sdp, sdpKey, salt) {
  const compressed = await deflate(te.encode(sdp))
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sdpKey, compressed))
  const out = new Uint8Array(MAGIC.length + SALT_LEN + IV_LEN + ct.length)
  out.set(MAGIC, 0)
  out.set(salt, MAGIC.length)
  out.set(iv, MAGIC.length + SALT_LEN)
  out.set(ct, MAGIC.length + SALT_LEN + IV_LEN)
  return toB64url(out)
}

export function parseBlob(blobStr) {
  const bytes = fromB64url(cleanBlob(blobStr))
  if (bytes.length < MAGIC.length + SALT_LEN + IV_LEN + 17 ||
      !MAGIC.every((b, i) => bytes[i] === b)) {
    throw new Error('BAD_FORMAT')
  }
  let off = MAGIC.length
  const salt = bytes.slice(off, off += SALT_LEN)
  const iv = bytes.slice(off, off += IV_LEN)
  const ct = bytes.slice(off)
  return { salt, iv, ct }
}

export async function openSdp({ iv, ct }, sdpKey) {
  let compressed
  try {
    compressed = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, sdpKey, ct)
  } catch {
    throw new Error('BAD_KEY')
  }
  return td.decode(await inflate(new Uint8Array(compressed)))
}

// Message wire format: iv(12) ‖ ciphertext, sent as binary over the DataChannel.
export async function encryptMsg(text, msgKey) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, msgKey, te.encode(text)))
  const out = new Uint8Array(IV_LEN + ct.length)
  out.set(iv, 0)
  out.set(ct, IV_LEN)
  return out.buffer
}

export async function decryptMsg(buffer, msgKey) {
  const bytes = new Uint8Array(buffer)
  const iv = bytes.slice(0, IV_LEN)
  const ct = bytes.slice(IV_LEN)
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, msgKey, ct)
    return td.decode(pt)
  } catch {
    throw new Error('BAD_KEY')
  }
}

// JSON envelopes over the DataChannel (sync protocol, chat/draw entries)
export async function encryptJson(obj, msgKey) {
  return encryptMsg(JSON.stringify(obj), msgKey)
}

export async function decryptJson(buffer, msgKey) {
  return JSON.parse(await decryptMsg(buffer, msgKey))
}

// Backup files: MAGIC_EXPORT(4) ‖ salt(16) ‖ iv(12) ‖ ct(deflate(json)), base64url.
// Same passphrase-derived key family as the session; salt travels in the file so
// a backup can be restored on a fresh device with just the file + passphrase.
export async function sealExport(obj, exportKey, salt) {
  const compressed = await deflate(te.encode(JSON.stringify(obj)))
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, exportKey, compressed))
  const out = new Uint8Array(MAGIC_EXPORT.length + SALT_LEN + IV_LEN + ct.length)
  out.set(MAGIC_EXPORT, 0)
  out.set(salt, MAGIC_EXPORT.length)
  out.set(iv, MAGIC_EXPORT.length + SALT_LEN)
  out.set(ct, MAGIC_EXPORT.length + SALT_LEN + IV_LEN)
  return toB64url(out)
}

export function parseExportBlob(blobStr) {
  const bytes = fromB64url(cleanBlob(blobStr))
  if (bytes.length < MAGIC_EXPORT.length + SALT_LEN + IV_LEN + 17 ||
      !MAGIC_EXPORT.every((b, i) => bytes[i] === b)) {
    throw new Error('BAD_FORMAT')
  }
  let off = MAGIC_EXPORT.length
  const salt = bytes.slice(off, off += SALT_LEN)
  const iv = bytes.slice(off, off += IV_LEN)
  const ct = bytes.slice(off)
  return { salt, iv, ct }
}

export async function openExport({ iv, ct }, exportKey) {
  let compressed
  try {
    compressed = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, exportKey, ct)
  } catch {
    throw new Error('BAD_KEY')
  }
  return JSON.parse(td.decode(await inflate(new Uint8Array(compressed))))
}
