// Forces iceTransportPolicy:'relay' on both tabs — no direct/host/srflx paths
// allowed, everything must flow through the TURN relay. Simulates the
// worst-case NAT pair (e.g. CGNAT on both ends) that STUN cannot traverse.
import { launch } from 'puppeteer-core'
import { resolve } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DIST = resolve(import.meta.dirname, '../dist/index.html')

const browser = await launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
  ],
})

const forceRelay = (page) => page.evaluateOnNewDocument(() => {
  const Orig = window.RTCPeerConnection
  window.RTCPeerConnection = class extends Orig {
    constructor(cfg = {}) { super({ ...cfg, iceTransportPolicy: 'relay' }) }
  }
})

const url = 'file://' + DIST
const pageA = await browser.newPage()
const pageB = await browser.newPage()
await forceRelay(pageA)
await forceRelay(pageB)
await pageA.goto(url)
await pageB.goto(url)

try {
  await pageA.bringToFront()
  await pageA.click('#btn-host')
  await pageA.waitForFunction(
    () => document.getElementById('host-offer').value.length > 100,
    { timeout: 30000, polling: 200 })
  const passphrase = await pageA.$eval('#host-pass', (el) => el.textContent)
  const codeA = await pageA.$eval('#host-offer', (el) => el.value)

  await pageB.bringToFront()
  await pageB.click('#btn-join')
  await pageB.type('#join-pass', passphrase)
  await pageB.$eval('#join-offer', (el, v) => { el.value = v }, codeA)
  await pageB.click('#btn-join-answer')
  await pageB.waitForFunction(
    () => document.getElementById('join-answer').value.length > 100,
    { timeout: 30000, polling: 200 })
  const codeB = await pageB.$eval('#join-answer', (el) => el.value)

  await pageA.bringToFront()
  await pageA.$eval('#host-answer', (el, v) => { el.value = v }, codeB)
  await pageA.click('#btn-host-connect')
  const onChat = (p) => p.waitForFunction(
    () => !document.getElementById('screen-chat').hidden, { timeout: 40000, polling: 200 })
  await Promise.all([onChat(pageA), onChat(pageB)])

  // confirm the selected pair really is relay→relay
  const pairType = await pageA.evaluate(async () => {
    const stats = await window.__pc.getStats()
    for (const s of stats.values()) {
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) {
        const l = stats.get(s.localCandidateId), r = stats.get(s.remoteCandidateId)
        return `${l?.candidateType}→${r?.candidateType}`
      }
    }
  })
  console.log('selected pair:', pairType)

  await pageA.bringToFront()
  await pageA.type('#msg-input', 'hello via TURN relay')
  await pageA.keyboard.press('Enter')
  await pageB.waitForFunction(
    () => [...document.querySelectorAll('#messages li.them')]
      .some((li) => li.textContent === 'hello via TURN relay'), { timeout: 15000, polling: 200 })
  console.log('relay-only message delivered + decrypted')
  console.log('relay e2e: ALL PASS')
} catch (err) {
  console.error('FAIL:', err.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
