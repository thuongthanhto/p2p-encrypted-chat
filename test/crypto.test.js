// Node unit tests for the crypto module (Node ≥18 has WebCrypto + CompressionStream).
import assert from 'node:assert/strict'
import {
  generatePassphrase, randomSalt, deriveKeys,
  sealSdp, parseBlob, openSdp, encryptMsg, decryptMsg, cleanBlob,
} from '../src/crypto.js'
import { WORDS } from '../src/words.js'

const FAKE_SDP = `v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\n` +
  `a=candidate:1 1 udp 2122260223 192.168.1.10 54321 typ host\r\n`.repeat(8) +
  `a=fingerprint:sha-256 ${'AB:'.repeat(31)}AB\r\n`

// wordlist sanity
assert.equal(new Set(WORDS).size, WORDS.length, 'wordlist has duplicates')
assert.ok(WORDS.length >= 300, 'wordlist too small')

// passphrase shape
const pass = generatePassphrase()
assert.match(pass, /^([a-z]+-){4}\d{2}$/, `unexpected passphrase shape: ${pass}`)

// SDP seal/open roundtrip
const salt = randomSalt()
const keys = await deriveKeys(pass, salt)
const blobStr = await sealSdp(FAKE_SDP, keys.sdpKey, salt)
assert.match(blobStr, /^[A-Za-z0-9_-]+$/, 'blob is not base64url')
console.log(`blob length for ~${FAKE_SDP.length}B SDP: ${blobStr.length} chars`)

const parsed = parseBlob(blobStr)
const keys2 = await deriveKeys(pass, parsed.salt) // guest derives from embedded salt
assert.equal(await openSdp(parsed, keys2.sdpKey), FAKE_SDP, 'SDP roundtrip failed')

// whitespace/garbage injected by messengers gets cleaned
const mangled = blobStr.slice(0, 50) + ' \n\t' + blobStr.slice(50) + '.'
assert.equal(await openSdp(parseBlob(mangled), keys2.sdpKey), FAKE_SDP, 'cleanBlob failed')
assert.equal(cleanBlob(' a b\nc.'), 'abc')

// wrong passphrase must fail, not garbage-decrypt
const badKeys = await deriveKeys(pass + 'x', parsed.salt)
await assert.rejects(openSdp(parsed, badKeys.sdpKey), /BAD_KEY/, 'wrong pass should throw')

// malformed blob
assert.throws(() => parseBlob('AAAA'), /BAD_FORMAT/)

// message roundtrip + tamper detection
const wire = await encryptMsg('hello 🔒 tiếng Việt', keys.msgKey)
assert.equal(await decryptMsg(wire, keys2.msgKey), 'hello 🔒 tiếng Việt')
const tampered = new Uint8Array(wire.slice(0))
tampered[tampered.length - 1] ^= 0xff
await assert.rejects(decryptMsg(tampered.buffer, keys2.msgKey), /BAD_KEY/)

// same passphrase, different unicode normalization → same key
const nfd = 'café-lagoon-fern-elk-42'.normalize('NFD')
const nfc = 'café-lagoon-fern-elk-42'.normalize('NFC')
const kA = await deriveKeys(nfd, salt)
const kB = await deriveKeys(nfc, salt)
const probe = await encryptMsg('x', kA.msgKey)
assert.equal(await decryptMsg(probe, kB.msgKey), 'x', 'NFC/NFD normalization broken')

console.log('crypto tests: ALL PASS')
