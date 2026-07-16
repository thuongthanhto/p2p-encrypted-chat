// Reproduces slow manual signaling: the guest creates CODE-B immediately but the
// host only pastes it after a delay (like a real Zalo/Signal exchange).
// Usage: node test/slow-exchange.js <delaySeconds>
import { launch } from 'puppeteer-core'
import { resolve } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DIST = resolve(import.meta.dirname, '../dist/index.html')
const DELAY_S = Number(process.argv[2] || 60)

const browser = await launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
  ],
})

const url = 'file://' + DIST
const pageA = await browser.newPage()
const pageB = await (await browser.createBrowserContext()).newPage()
pageA.on('console', (m) => m.text().startsWith('[p2p]') && console.log('A', m.text()))
pageB.on('console', (m) => m.text().startsWith('[p2p]') && console.log('B', m.text()))
await pageA.goto(url)
await pageB.goto(url)

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
console.log(`guest answer ready — host will paste CODE-B after ${DELAY_S}s…`)

const guestState = () => pageB.evaluate(() => ({
  conn: window.__pc.connectionState,
  ice: window.__pc.iceConnectionState,
  err: document.getElementById('join-error').hidden ? '' :
    document.getElementById('join-error').textContent.slice(0, 50),
}))

for (let t = 0; t < DELAY_S; t += 5) {
  const g = await guestState()
  console.log(`t=${t}s guest: ${g.conn}/${g.ice} ${g.err}`)
  await new Promise((r) => setTimeout(r, 5000))
}

await pageA.bringToFront()
await pageA.$eval('#host-answer', (el, v) => { el.value = v }, codeB)
await pageA.click('#btn-host-connect')
console.log(`host pasted CODE-B at t=${DELAY_S}s`)

const connected = await Promise.all([
  pageA.waitForFunction(() => !document.getElementById('screen-chat').hidden,
    { timeout: 30000, polling: 200 }),
  pageB.waitForFunction(() => !document.getElementById('screen-chat').hidden,
    { timeout: 30000, polling: 200 }),
]).then(() => true).catch(() => false)

const g = await guestState()
console.log(`final guest: ${g.conn}/${g.ice} ${g.err}`)
console.log(`RESULT delay=${DELAY_S}s connected=${connected}`)
await browser.close()
