import {
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'

/**
 * A note as the layout receives it: its path, and where it already sits when
 * it was drawn before.
 */
export interface LayoutNodeInput {
  readonly id: string
  readonly x?: number | undefined
  readonly y?: number | undefined
  /**
   * New, and started beside its neighbours rather than drawn before. Its
   * position is used, but doesn't count towards a gentle restart.
   */
  readonly seeded?: boolean | undefined
}

export interface LayoutLinkInput {
  readonly source: string
  readonly target: string
}

interface LayoutNode extends SimulationNodeDatum {
  id: string
}

type LayoutLink = SimulationLinkDatum<LayoutNode>

/**
 * The Explore force layout, kept free of the DOM so it can run in a worker
 * (`explore-layout.worker.ts`) and be tested in node.
 */
export interface ExploreLayout {
  /**
   * Replace the graph. Notes passed with a position keep it; when most are
   * placed, the layout restarts with less energy so the picture doesn't jump,
   * and least when they were drawn before rather than just seeded.
   */
  setGraph(nodes: readonly LayoutNodeInput[], links: readonly LayoutLinkInput[]): void
  /** Pin a note under the pointer and keep the layout moving around it. */
  drag(id: string, pointerX: number, pointerY: number): void
  /** Let a dragged note go. */
  release(id: string): void
  /**
   * Step the layout for up to `budgetMs`. Returns whether it still needs
   * steps: false once it has settled and nothing is being dragged.
   */
  run(budgetMs: number): boolean
  /** Positions as `[x0, y0, x1, y1, …]`, in the order `setGraph` received. */
  positions(): Float32Array<ArrayBuffer>
}

/** A layout with most notes drawn before restarts at this energy, not full. */
const GENTLE_ALPHA = 0.3
/**
 * A layout whose notes are mostly placed, but many only just started beside
 * their neighbours, restarts at this energy: enough to spread the new notes
 * out, not enough to scramble the rest.
 */
const SEEDED_ALPHA = 0.5
/** Energy kept up while a note is dragged, so its neighbours follow. */
const DRAG_ALPHA = 0.3
/** Above this share of placed notes, a new graph counts as a refresh. */
const REFRESH_PLACED_SHARE = 0.9

export function createExploreLayout(): ExploreLayout {
  let nodes: LayoutNode[] = []
  let byId = new Map<string, LayoutNode>()
  const links = forceLink<LayoutNode, LayoutLink>().id((node) => node.id)
  const simulation = forceSimulation<LayoutNode, LayoutLink>()
    .force('link', links)
    .force('charge', forceManyBody())
    // Weak gravity rather than a centring force: it also pulls small
    // disconnected clusters in, instead of letting them drift off and shrink
    // the fitted view.
    .force('x', forceX(0).strength(0.03))
    .force('y', forceY(0).strength(0.03))
    .alphaDecay(0.04)
    .stop()

  return {
    setGraph(nextNodes, nextLinks) {
      nodes = nextNodes.map((input) => ({
        id: input.id,
        ...(input.x === undefined ? {} : { x: input.x }),
        ...(input.y === undefined ? {} : { y: input.y }),
      }))
      byId = new Map(nodes.map((node) => [node.id, node]))
      simulation.nodes(nodes)
      links.links(nextLinks.map(({ source, target }) => ({ source, target })))
      simulation.alpha(restartAlpha(nextNodes))
    },
    drag(id, pointerX, pointerY) {
      const node = byId.get(id)
      if (node === undefined) {
        return
      }
      node.fx = pointerX
      node.fy = pointerY
      simulation.alphaTarget(DRAG_ALPHA)
      if (simulation.alpha() < DRAG_ALPHA) {
        simulation.alpha(DRAG_ALPHA)
      }
    },
    release(id) {
      const node = byId.get(id)
      if (node !== undefined) {
        node.fx = null
        node.fy = null
      }
      simulation.alphaTarget(0)
    },
    run(budgetMs) {
      const started = performance.now()
      while (isRunning() && performance.now() - started < budgetMs) {
        simulation.tick()
      }
      return isRunning()
    },
    positions() {
      const positions = new Float32Array(nodes.length * 2)
      for (const [index, node] of nodes.entries()) {
        positions[index * 2] = node.x ?? 0
        positions[index * 2 + 1] = node.y ?? 0
      }
      return positions
    },
  }

  function restartAlpha(nextNodes: readonly LayoutNodeInput[]): number {
    const placed = nextNodes.filter((node) => node.x !== undefined)
    const kept = placed.filter((node) => node.seeded !== true).length
    const refresh = REFRESH_PLACED_SHARE * nextNodes.length
    if (placed.length === 0 || placed.length < refresh) {
      return 1
    }
    return kept >= refresh ? GENTLE_ALPHA : SEEDED_ALPHA
  }

  function isRunning(): boolean {
    return (
      nodes.length > 0 &&
      (simulation.alpha() >= simulation.alphaMin() || simulation.alphaTarget() > 0)
    )
  }
}
