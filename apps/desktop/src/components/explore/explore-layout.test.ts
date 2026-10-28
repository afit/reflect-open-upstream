import { describe, expect, it } from 'vitest'
import { createExploreLayout } from './explore-layout.ts'

const NODES = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
const LINKS = [
  { source: 'a', target: 'b' },
  { source: 'b', target: 'c' },
]

function settle(layout: ReturnType<typeof createExploreLayout>): void {
  for (let slice = 0; slice < 1000 && layout.run(50); slice++) {
    // Each slice steps until its budget runs out or the layout settles.
  }
}

function distance(positions: Float32Array, from: number, to: number): number {
  return Math.hypot(
    positions[from * 2]! - positions[to * 2]!,
    positions[from * 2 + 1]! - positions[to * 2 + 1]!,
  )
}

describe('createExploreLayout', () => {
  it('settles, keeping linked notes close and positions in input order', () => {
    const layout = createExploreLayout()
    layout.setGraph(NODES, LINKS)

    settle(layout)

    expect(layout.run(50)).toBe(false)
    const positions = layout.positions()
    expect(positions).toHaveLength(6)
    expect(distance(positions, 0, 1)).toBeLessThan(distance(positions, 0, 2))
  })

  it('restarts gently when most notes keep their positions', () => {
    const layout = createExploreLayout()
    layout.setGraph(NODES, LINKS)
    settle(layout)
    const before = layout.positions()
    const placed = NODES.map(({ id }, index) => ({
      id,
      x: before[index * 2]!,
      y: before[index * 2 + 1]!,
    }))

    layout.setGraph(placed, LINKS)
    settle(layout)

    const after = layout.positions()
    for (let index = 0; index < NODES.length; index++) {
      const moved = Math.hypot(
        after[index * 2]! - before[index * 2]!,
        after[index * 2 + 1]! - before[index * 2 + 1]!,
      )
      expect(moved).toBeLessThan(5)
    }
  })

  it('pins a dragged note and keeps running until it is released', () => {
    const layout = createExploreLayout()
    layout.setGraph(NODES, LINKS)
    settle(layout)

    layout.drag('a', 500, 500)
    expect(layout.run(20)).toBe(true)
    expect([...layout.positions().slice(0, 2)]).toEqual([500, 500])

    layout.release('a')
    settle(layout)
    expect(layout.run(20)).toBe(false)
  })

  it('has nothing to run without a graph', () => {
    const layout = createExploreLayout()

    expect(layout.run(20)).toBe(false)
    expect(layout.positions()).toHaveLength(0)
  })
})
