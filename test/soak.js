// Soak test: connect two tabs, then sit idle and watch connection state —
// reproduces "Connection lost appears while chat still works" reports.
import { launch } from 'puppeteer-core'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DIST = resolve(import.meta.dirname, '../dist/index.html')
const SOAK_SECONDS = Number(process.argv[2] || 120)

if (!existsSync(DIST)) {
  console.error('dist/index.html not found — run `npm run build` first')
  process.exit(1)
}

// MDNS=1 keeps Chrome's default mDNS-obfuscated host candidates (matches real
// user environments); default disables it for deterministic loopback runs.
const mdns = process.env.MDNS === '1'
const browser = await launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    ...(mdns ? [] : ['--disable-features=WebRtcHideLocalIpsWithMdns']),
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
  ],
})
console.log('mDNS host obfuscation:', mdns ? 'ON (Chrome default)' : 'off')

const url = 'file://' + DIST
const pageA = await browser.newPage()
const pageB = await (await browser.createBrowserContext()).newPage()
pageA.on('console', (m) => m.text().startsWith('[p2p]') && console.log('A', m.text()))
pageB.on('console', (m) => m.text().startsWith('[p2p]') && console.log('B', m.text()))
await pageA.goto(url)
await pageB.goto(url)

// connect (same flow as e2e)
await pageA.bringToFront()
await pageA.click('#btn-host')
await pageA.waitForFunction(
  () => document.getElementById('host-offer').value.length > 100,
  { timeout: 15000, polling: 200 })
const passphrase = await pageA.$eval('#host-pass', (el) => el.textContent)
const codeA = await pageA.$eval('#host-offer', (el) => el.value)

await pageB.bringToFront()
await pageB.click('#btn-join')
await pageB.type('#join-pass', passphrase)
await pageB.$eval('#join-offer', (el, v) => { el.value = v }, codeA)
await pageB.click('#btn-join-answer')
await pageB.waitForFunction(
  () => document.getElementById('join-answer').value.length > 100,
  { timeout: 15000, polling: 200 })
const codeB = await pageB.$eval('#join-answer', (el) => el.value)

await pageA.bringToFront()
await pageA.$eval('#host-answer', (el, v) => { el.value = v }, codeB)
await pageA.click('#btn-host-connect')
const onChat = (p) => p.waitForFunction(
  () => !document.getElementById('screen-chat').hidden, { timeout: 20000, polling: 200 })
await Promise.all([onChat(pageA), onChat(pageB)])
console.log('connected — soaking idle for', SOAK_SECONDS, 'seconds…')

const snap = (p) => p.evaluate(async () => {
  const pc = window.__pc
  let pair = ''
  try {
    const stats = await pc.getStats()
    for (const s of stats.values()) {
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) {
        const local = stats.get(s.localCandidateId)
        const remote = stats.get(s.remoteCandidateId)
        pair = `${local?.candidateType}→${remote?.candidateType} rtt=${s.currentRoundTripTime}`
      }
    }
  } catch {}
  return {
    conn: pc.connectionState,
    ice: pc.iceConnectionState,
    dc: document.getElementById('msg-input').disabled ? 'input-disabled' : 'input-ok',
    banner: document.getElementById('banner').hidden ? '' :
      document.getElementById('banner').textContent.trim().slice(0, 40),
    pair,
  }
})

for (let t = 0; t <= SOAK_SECONDS; t += 5) {
  const [a, b] = await Promise.all([snap(pageA), snap(pageB)])
  console.log(`t=${t}s A: ${a.conn}/${a.ice} ${a.dc} ${a.banner} | B: ${b.conn}/${b.ice} ${b.dc} ${b.banner}`)
  if (t === 0 || a.banner || b.banner) console.log('  pairs:', a.pair, '|', b.pair)
  await new Promise((r) => setTimeout(r, 5000))
}

// after the soak, messages must still flow
await pageA.bringToFront()
await pageA.type('#msg-input', 'still alive?')
await pageA.keyboard.press('Enter')
const delivered = await pageB.waitForFunction(
  () => [...document.querySelectorAll('#messages li.them')]
    .some((li) => li.textContent === 'still alive?'), { timeout: 10000, polling: 200 })
  .then(() => true).catch(() => false)
console.log('post-soak message delivered:', delivered)

await browser.close()
