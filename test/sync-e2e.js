// The rejoin + offline-sync scenario the customer asked for:
//   1. A and B chat, B closes the tab.
//   2. A keeps typing while B is gone (messages queue in A's local log).
//   3. B reopens the app — the room is still on B's device (localStorage).
//   4. They reconnect with fresh codes (roles swapped: B hosts this time).
//   5. B must end up with the full history including the offline message.
import { launch } from 'puppeteer-core'
import { resolve } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DIST = resolve(import.meta.dirname, '../dist/index.html')

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
const opt = { timeout: 20000, polling: 200 }

function fail(msg) {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}

async function connect(hostPage, guestPage, viaRoomCard) {
  await hostPage.bringToFront()
  if (viaRoomCard) {
    await hostPage.evaluate(() => [...document.querySelectorAll('.room-card button')]
      .find((b) => b.textContent === 'Create code').click())
  } else {
    await hostPage.click('#btn-host')
  }
  await hostPage.waitForFunction(
    () => document.getElementById('host-offer').value.length > 100, opt)
  const passphrase = await hostPage.$eval('#host-pass', (el) => el.textContent)
  const codeA = await hostPage.$eval('#host-offer', (el) => el.value)

  await guestPage.bringToFront()
  if (viaRoomCard) {
    await guestPage.evaluate(() => [...document.querySelectorAll('.room-card button')]
      .find((b) => b.textContent === 'Paste code').click())
    await guestPage.waitForFunction(
      () => !document.getElementById('screen-join').hidden &&
        document.getElementById('join-pass').value.length > 0, opt)
    const prefilled = await guestPage.$eval('#join-pass', (el) => el.value)
    if (prefilled !== passphrase) fail('rejoin should prefill the room passphrase')
  } else {
    await guestPage.click('#btn-join')
    await guestPage.type('#join-pass', passphrase)
  }
  await guestPage.$eval('#join-offer', (el, v) => { el.value = v }, codeA)
  await guestPage.click('#btn-join-answer')
  await guestPage.waitForFunction(
    () => document.getElementById('join-answer').value.length > 100, opt)
  const codeB = await guestPage.$eval('#join-answer', (el) => el.value)

  await hostPage.bringToFront()
  await hostPage.$eval('#host-answer', (el, v) => { el.value = v }, codeB)
  await hostPage.click('#btn-host-connect')
  const onChat = (p) => p.waitForFunction(
    () => !document.getElementById('screen-chat').hidden &&
      !document.getElementById('chat-state').classList.contains('off'), opt)
  await Promise.all([onChat(hostPage), onChat(guestPage)])
}

async function send(page, text) {
  await page.bringToFront()
  await page.type('#msg-input', text)
  await page.keyboard.press('Enter')
}

const hasMsg = (page, text) => page.waitForFunction(
  (t) => [...document.querySelectorAll('#messages li')].some((li) => li.textContent === t),
  opt, text)

try {
  // session 1: A hosts, B joins
  // isolated storage per peer; keep B's context so its localStorage survives
  // the tab close and "reopen the app" later
  const contextB = await browser.createBrowserContext()
  const pageA = await browser.newPage()
  let pageB = await contextB.newPage()
  await pageA.goto(url)
  await pageB.goto(url)
  await connect(pageA, pageB, false)
  await send(pageA, 'msg-1 from A')
  await send(pageB, 'msg-2 from B')
  await hasMsg(pageB, 'msg-1 from A')
  await hasMsg(pageA, 'msg-2 from B')
  console.log('session 1: connected, messages flow')

  // B goes offline; A keeps typing
  await pageB.close()
  await pageA.bringToFront()
  await pageA.waitForFunction(
    () => !document.getElementById('banner').hidden, { timeout: 30000, polling: 200 })
  await send(pageA, 'msg-3 while B offline')
  console.log('B closed; A queued an offline message')

  // B comes back: room survived on disk, B hosts the reconnect
  pageB = await contextB.newPage()
  await pageB.goto(url)
  await pageB.waitForFunction(
    () => document.querySelectorAll('.room-card').length === 1, opt)
  console.log('B reopened the app — room card is there')

  // A navigates back to the room list and answers B's new code
  await pageA.bringToFront()
  await pageA.click('#btn-reconnect')
  await pageA.waitForFunction(
    () => document.querySelectorAll('.room-card').length === 1, opt)

  await connect(pageB, pageA, true) // roles swapped, via room cards
  console.log('session 2: reconnected via room cards (roles swapped)')

  // the offline message must arrive, and B's own history must survive
  await hasMsg(pageB, 'msg-3 while B offline')
  await hasMsg(pageB, 'msg-1 from A')
  await hasMsg(pageB, 'msg-2 from B')
  await hasMsg(pageA, 'msg-1 from A')
  console.log('offline message delivered; full history on both sides')

  // and the log converges to the same order on both devices
  const logA = await pageA.evaluate(() => window.__room.log.map((e) => e.id))
  const logB = await pageB.evaluate(() => window.__room.log.map((e) => e.id))
  if (JSON.stringify(logA) !== JSON.stringify(logB)) {
    fail(`logs diverge:\nA=${logA}\nB=${logB}`)
  }
  console.log('logs converged identically')

  console.log('sync e2e: ALL PASS')
} catch (err) {
  fail(err.stack || String(err))
} finally {
  await browser.close()
}
