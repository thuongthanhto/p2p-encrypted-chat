// Checks which ICE candidate types are reachable from this machine using the
// app's real ICE config (src/rtc.js). A "relay" line means TURN works.
import { launch } from 'puppeteer-core'
import { ICE_SERVERS } from '../src/rtc.js'

const browser = await launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
})

const page = await browser.newPage()
const result = await page.evaluate(async (iceServers) => {
  const pc = new RTCPeerConnection({ iceServers })
  pc.createDataChannel('probe')
  const types = {}
  const errors = []
  pc.addEventListener('icecandidate', (e) => {
    const m = e.candidate?.candidate.match(/ typ (\w+)/)
    if (m) types[m[1]] = (types[m[1]] || 0) + 1
  })
  pc.addEventListener('icecandidateerror', (e) => {
    errors.push(`${e.url} → ${e.errorCode} ${e.errorText}`)
  })
  await pc.setLocalDescription(await pc.createOffer())
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 15000)
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve() }
    })
  })
  pc.close()
  return { types, errors }
}, ICE_SERVERS)

console.log('candidate types gathered:', JSON.stringify(result.types))
for (const err of result.errors) console.log('ice error:', err)
console.log(result.types.relay ? 'TURN relay: REACHABLE ✓' : 'TURN relay: NOT reachable ✗')
await browser.close()
process.exit(result.types.relay ? 0 : 1)
