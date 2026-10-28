import { createExploreLayout } from './explore-layout.ts'
import { toLayoutWorkerSchema, type FromLayoutWorker } from './explore-layout-protocol.ts'

/**
 * Runs the Explore force layout off the main thread: a layout step over a
 * large graph takes tens of milliseconds, which on the main thread stalls
 * every frame. Steps run in short slices, yielding between them so drag
 * messages land promptly, and post positions after each slice.
 */

/** Step for at most this long before posting positions and yielding. */
const SLICE_MS = 12

const layout = createExploreLayout()
let generation = 0
let scheduled = false

addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = toLayoutWorkerSchema.parse(event.data)
  switch (message.type) {
    case 'graph':
      generation = message.generation
      layout.setGraph(message.nodes, message.links)
      break
    case 'drag':
      layout.drag(message.id, message.x, message.y)
      break
    case 'release':
      layout.release(message.id)
      break
  }
  schedule()
})

function schedule(): void {
  if (!scheduled) {
    scheduled = true
    setTimeout(step, 0)
  }
}

function step(): void {
  scheduled = false
  const running = layout.run(SLICE_MS)
  const positions = layout.positions()
  const reply: FromLayoutWorker = { type: 'positions', generation, positions, settled: !running }
  postMessage(reply, { transfer: [positions.buffer] })
  if (running) {
    schedule()
  }
}
