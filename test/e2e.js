// End-to-end test: drive the built single-file app in two real Chrome tabs,
// walk the full manual-signaling flow, and assert messages arrive both ways.
import { launch } from 'puppeteer-core'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DIST = resolve(import.meta.dirname, '../dist/index.html')

if (!existsSync(DIST)) {
  console.error('dist/index.html not found — run `npm run build` first')
  process.exit(1)
}

const browser = await launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    // mDNS candidates don't resolve reliably in headless — use raw host IPs
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    // both tabs must keep running while backgrounded, or evaluate() stalls
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
  ],
})

function fail(msg) {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}

try {
  const url = 'file://' + DIST
  const pageA = await browser.newPage()
  const pageB = await browser.newPage()
  await pageA.goto(url)
  await pageB.goto(url)

  // A: create room, wait for CODE-A
  await pageA.bringToFront()
  await pageA.click('#btn-host')
  await pageA.waitForFunction(
    () => document.getElementById('host-offer').value.length > 100,
    { timeout: 15000, polling: 200 })
  const passphrase = await pageA.$eval('#host-pass', (el) => el.textContent)
  const codeA = await pageA.$eval('#host-offer', (el) => el.value)
  console.log(`passphrase: ${passphrase}`)
  console.log(`CODE-A length: ${codeA.length} chars`)

  // B: join with passphrase + CODE-A (mangled like a messenger would), get CODE-B
  await pageB.bringToFront()
  await pageB.click('#btn-join')
  await pageB.type('#join-pass', passphrase)
  const mangledA = codeA.slice(0, 80) + '\n ' + codeA.slice(80) + ' '
  await pageB.$eval('#join-offer', (el, v) => { el.value = v }, mangledA)
  await pageB.click('#btn-join-answer')
  await pageB.waitForFunction(
    () => document.getElementById('join-answer').value.length > 100,
    { timeout: 15000, polling: 200 })
  const codeB = await pageB.$eval('#join-answer', (el) => el.value)
  console.log(`CODE-B length: ${codeB.length} chars`)

  // A: paste CODE-B, connect
  await pageA.bringToFront()
  await pageA.$eval('#host-answer', (el, v) => { el.value = v }, codeB)
  await pageA.click('#btn-host-connect')

  // both sides should land on the chat screen
  const onChat = (p) => p.waitForFunction(
    () => !document.getElementById('screen-chat').hidden, { timeout: 20000, polling: 200 })
  await Promise.all([onChat(pageA), onChat(pageB)])
  console.log('DataChannel open on both sides')

  // A → B
  await pageA.bringToFront()
  await pageA.type('#msg-input', 'hello from A 🔒')
  await pageA.keyboard.press('Enter')
  await pageB.waitForFunction(
    () => [...document.querySelectorAll('#messages li.them')]
      .some((li) => li.textContent === 'hello from A 🔒'), { timeout: 10000, polling: 200 })
  console.log('A → B message delivered + decrypted')

  // B → A
  await pageB.bringToFront()
  await pageB.type('#msg-input', 'reply from B ✓')
  await pageB.keyboard.press('Enter')
  await pageA.waitForFunction(
    () => [...document.querySelectorAll('#messages li.them')]
      .some((li) => li.textContent === 'reply from B ✓'), { timeout: 10000, polling: 200 })
  console.log('B → A message delivered + decrypted')

  // negative check: wrong passphrase must show an error, not connect
  const pageC = await browser.newPage()
  await pageC.goto(url)
  await pageC.bringToFront()
  await pageC.click('#btn-join')
  await pageC.type('#join-pass', 'wrong-pass-entirely-00')
  await pageC.$eval('#join-offer', (el, v) => { el.value = v }, codeA)
  await pageC.click('#btn-join-answer')
  await pageC.waitForFunction(
    () => !document.getElementById('join-error').hidden, { timeout: 15000, polling: 200 })
  const errText = await pageC.$eval('#join-error', (el) => el.textContent)
  if (!/passphrase/i.test(errText)) fail(`unexpected error text: ${errText}`)
  console.log('wrong passphrase correctly rejected')

  // peer going away → the other side must show the connection-lost banner
  await pageB.goto('about:blank')
  await pageA.waitForFunction(
    () => !document.getElementById('banner').hidden &&
      document.getElementById('msg-input').disabled &&
      /Connection lost/.test(document.getElementById('banner').textContent),
    { timeout: 30000, polling: 200 })
  console.log('peer loss shows connection-lost banner')

  console.log('e2e: ALL PASS')
} catch (err) {
  fail(err.stack || String(err))
} finally {
  await browser.close()
}
