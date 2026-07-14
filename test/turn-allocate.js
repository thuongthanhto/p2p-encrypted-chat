// Raw TURN Allocate probe (RFC 5766 long-term credentials) — talks to the TURN
// server directly to see the exact auth verdict, independent of the browser.
// Usage: node test/turn-allocate.js [host] [port] [username] [password]
import dgram from 'node:dgram'
import { createHash, createHmac, randomBytes } from 'node:crypto'

const [host = 'free.expressturn.com', port = '3478',
  username = '000000002099398072', password = 'Q4cgodd4LcaiqCyxn47FESSpY2o='] =
  process.argv.slice(2)

const ALLOCATE = 0x0003
const MAGIC = 0x2112a442

function attr(type, value) {
  const pad = (4 - (value.length % 4)) % 4
  const buf = Buffer.alloc(4 + value.length + pad)
  buf.writeUInt16BE(type, 0)
  buf.writeUInt16BE(value.length, 2)
  value.copy(buf, 4)
  return buf
}

function msg(type, attrs, txid) {
  const body = Buffer.concat(attrs)
  const head = Buffer.alloc(20)
  head.writeUInt16BE(type, 0)
  head.writeUInt16BE(body.length, 2)
  head.writeUInt32BE(MAGIC, 4)
  txid.copy(head, 8)
  return Buffer.concat([head, body])
}

function withIntegrity(type, attrs, txid, key) {
  // header length must cover the future MESSAGE-INTEGRITY attr (24 bytes)
  const body = Buffer.concat(attrs)
  const head = Buffer.alloc(20)
  head.writeUInt16BE(type, 0)
  head.writeUInt16BE(body.length + 24, 2)
  head.writeUInt32BE(MAGIC, 4)
  txid.copy(head, 8)
  const mac = createHmac('sha1', key).update(Buffer.concat([head, body])).digest()
  return Buffer.concat([head, body, attr(0x0008, mac)])
}

function parseAttrs(buf) {
  const attrs = {}
  let off = 20
  while (off + 4 <= buf.length) {
    const type = buf.readUInt16BE(off)
    const len = buf.readUInt16BE(off + 2)
    attrs[type] = buf.slice(off + 4, off + 4 + len)
    off += 4 + len + ((4 - (len % 4)) % 4)
  }
  return attrs
}

function errorInfo(attrs) {
  const e = attrs[0x0009]
  if (!e) return null
  return { code: e[2] * 100 + e[3], reason: e.slice(4).toString() }
}

const sock = dgram.createSocket('udp4')
const reqTransport = attr(0x0019, Buffer.from([17, 0, 0, 0]))

function send(buf) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout — no UDP response')), 8000)
    sock.once('message', (m) => { clearTimeout(t); resolve(m) })
    sock.send(buf, Number(port), host)
  })
}

try {
  // round 1: unauthenticated → expect 401 with realm + nonce
  const tx1 = randomBytes(12)
  const r1 = parseAttrs(await send(msg(ALLOCATE, [reqTransport], tx1)))
  const e1 = errorInfo(r1)
  const realm = r1[0x0014]?.toString()
  const nonce = r1[0x0015]
  console.log(`round 1: ${e1 ? `${e1.code} ${e1.reason}` : 'unexpected success'}` +
    ` | realm=${realm} | software=${r1[0x8022]?.toString() ?? '?'}`)
  if (!realm || !nonce) process.exit(1)

  // round 2: authenticated with long-term credentials
  const key = createHash('md5').update(`${username}:${realm}:${password}`).digest()
  const tx2 = randomBytes(12)
  const r2raw = await send(withIntegrity(ALLOCATE, [
    reqTransport,
    attr(0x0006, Buffer.from(username)),
    attr(0x0014, Buffer.from(realm)),
    attr(0x0015, nonce),
  ], tx2, key))
  const type2 = r2raw.readUInt16BE(0)
  const r2 = parseAttrs(r2raw)
  const e2 = errorInfo(r2)
  if (type2 === 0x0103) {
    console.log('round 2: ALLOCATION SUCCESS ✓ — credentials are valid')
  } else {
    console.log(`round 2: ${e2 ? `${e2.code} ${e2.reason}` : `type 0x${type2.toString(16)}`}`)
  }
} catch (err) {
  console.error(String(err))
} finally {
  sock.close()
}
