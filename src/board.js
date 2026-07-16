// Shared whiteboard. Strokes are log entries like chat messages, so they sync,
// backfill, and export exactly the same way. Canvas uses a fixed logical
// coordinate space so both sides see the same picture at any window size.

export const BOARD_W = 1000
export const BOARD_H = 700

export function createBoard(canvas, { getColor, getWidth, onStroke }) {
  canvas.width = BOARD_W
  canvas.height = BOARD_H
  const ctx = canvas.getContext('2d')
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  let current = null

  function toLogical(e) {
    const r = canvas.getBoundingClientRect()
    return [
      Math.round((e.clientX - r.left) * BOARD_W / r.width),
      Math.round((e.clientY - r.top) * BOARD_H / r.height),
    ]
  }

  function drawStroke(s) {
    if (!s.p.length) return
    ctx.strokeStyle = s.c
    ctx.lineWidth = s.w
    ctx.beginPath()
    ctx.moveTo(s.p[0][0], s.p[0][1])
    for (const [x, y] of s.p.slice(1)) ctx.lineTo(x, y)
    if (s.p.length === 1) ctx.lineTo(s.p[0][0] + 0.1, s.p[0][1]) // dot
    ctx.stroke()
  }

  function clear() {
    ctx.clearRect(0, 0, BOARD_W, BOARD_H)
  }

  // replay the whole log: wipes reset the canvas, strokes accumulate
  function redraw(entries) {
    clear()
    for (const e of entries) {
      if (e.t === 'wipe') clear()
      else if (e.t === 'draw') drawStroke(e.s)
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    canvas.setPointerCapture(e.pointerId)
    current = { c: getColor(), w: getWidth(), p: [toLogical(e)] }
    drawStroke({ ...current, p: current.p })
  })

  canvas.addEventListener('pointermove', (e) => {
    if (!current) return
    const pt = toLogical(e)
    const last = current.p[current.p.length - 1]
    if (Math.abs(pt[0] - last[0]) + Math.abs(pt[1] - last[1]) < 3) return
    // draw only the new segment live; full stroke replays identically later
    ctx.strokeStyle = current.c
    ctx.lineWidth = current.w
    ctx.beginPath()
    ctx.moveTo(last[0], last[1])
    ctx.lineTo(pt[0], pt[1])
    ctx.stroke()
    current.p.push(pt)
  })

  const finish = () => {
    if (!current) return
    onStroke(current)
    current = null
  }
  canvas.addEventListener('pointerup', finish)
  canvas.addEventListener('pointercancel', finish)

  return { drawStroke, clear, redraw }
}
