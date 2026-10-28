import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import ForceGraph, { type LinkObject, type NodeObject } from 'force-graph'
import type { VisibleGraph } from './explore-graph-data.ts'
import { fromLayoutWorkerSchema, type ToLayoutWorker } from './explore-layout-protocol.ts'
import { readExplorePalette, type ExplorePalette } from './explore-palette.ts'
import { useTheme } from '@/providers/theme-provider.tsx'

interface ExploreNode extends NodeObject {
  id: string
  title: string
  daily: boolean
  degree: number
}

type ExploreLink = LinkObject<ExploreNode>

type ExploreGraph = ForceGraph<ExploreNode, ExploreLink>

/** How far apart seeded notes start: close enough to settle fast, far enough not to repel violently. */
const SEED_SPREAD = 80

/** Labels appear past this zoom, or on the hovered/selected note's neighbourhood. */
const LABEL_ZOOM = 2

/** Labels are drawn for notes this far outside the view, in screen pixels, so long titles aren't cut off at its edge. */
const LABEL_MARGIN = 200

const UNREADABLE_POSITIONS = 'The layout sent positions that could not be read.'

interface UseForceGraphOptions {
  readonly container: HTMLDivElement | null
  readonly graph: VisibleGraph
  /** The note search selected, highlighted like a hover until cleared. */
  readonly selected: string | null
  /**
   * Keep the view fitted to the graph while it lays out after this changes
   * (a filter toggle), until the user pans or zooms. Background refreshes
   * don't move the camera.
   */
  readonly fitKey: string
  readonly onOpen: (path: string, event: MouseEvent) => void
}

export interface ForceGraphControls {
  /** Pan and zoom to a note. */
  readonly focusNote: (path: string) => void
  /** The layout worker failed, so the map no longer moves. */
  readonly layoutError: Error | null
}

/**
 * Own a `force-graph` canvas in `container` for the screen's lifetime.
 *
 * force-graph only draws and handles input here. The layout runs in
 * `explore-layout.worker.ts`, because a layout step over a large graph takes
 * tens of milliseconds and on the main thread stalls every frame. The worker
 * posts positions as it goes; drags are forwarded to it.
 *
 * Node objects are kept by path across data updates, so a refresh keeps every
 * surviving note where it was. Highlight state lives in refs, not React
 * state: hovering redraws the canvas, never the component.
 */
export function useForceGraph({
  container,
  graph,
  selected,
  fitKey,
  onOpen,
}: UseForceGraphOptions): ForceGraphControls {
  const instanceRef = useRef<ExploreGraph | null>(null)
  const workerRef = useRef<Worker | null>(null)
  /** The notes drawn now. */
  const nodesRef = useRef(new Map<string, ExploreNode>())
  /**
   * Every note drawn since the screen opened, so a note hidden by a filter
   * and shown again returns to where it was.
   */
  const knownRef = useRef(new Map<string, ExploreNode>())
  /** The nodes in the order last sent to the worker, which its positions follow. */
  const orderRef = useRef<readonly ExploreNode[]>([])
  const generationRef = useRef(0)
  /** The graph last sent to the worker. */
  const laidOutRef = useRef<VisibleGraph | null>(null)
  /** The `fitKey` of the last non-empty graph laid out. */
  const fitKeyRef = useRef<string | null>(null)
  /** Fit the view on every position update until the layout settles. */
  const followRef = useRef(false)
  const neighboursRef = useRef(graph.neighbours)
  const hoveredRef = useRef<string | null>(null)
  const selectedRef = useRef(selected)
  const paletteRef = useRef<ExplorePalette | null>(null)
  const openNote = useEffectEvent(onOpen)
  const [layoutError, setLayoutError] = useState<Error | null>(null)
  /** Mirrors `layoutError !== null`, so a healthy layout doesn't set state on every update. */
  const failedRef = useRef(false)
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    if (container === null) {
      return
    }
    paletteRef.current = readExplorePalette(container)

    const anchor = (): string | null => hoveredRef.current ?? selectedRef.current
    const isLit = (id: string): boolean => {
      const current = anchor()
      return (
        current !== null &&
        (id === current || (neighboursRef.current.get(current)?.has(id) ?? false))
      )
    }
    const touchesAnchor = (link: ExploreLink): boolean => {
      const current = anchor()
      return (
        current !== null &&
        (endpointId(link.source) === current || endpointId(link.target) === current)
      )
    }
    const radius = (node: ExploreNode): number => 2 + Math.sqrt(node.degree) * 1.2

    // Worked out once per frame rather than once per note.
    let labelFont = ''
    let labelBounds = { left: 0, top: 0, right: 0, bottom: 0 }
    const prepareFrame = (scale: number): void => {
      const palette = paletteRef.current
      if (palette === null) {
        return
      }
      labelFont = `${11 / scale}px ${palette.font}`
      const margin = LABEL_MARGIN / scale
      const topLeft = instance.screen2GraphCoords(0, 0)
      const bottomRight = instance.screen2GraphCoords(instance.width(), instance.height())
      labelBounds = {
        left: topLeft.x - margin,
        top: topLeft.y - margin,
        right: bottomRight.x + margin,
        bottom: bottomRight.y,
      }
    }
    const inLabelBounds = (nodeX: number, nodeY: number): boolean => {
      const { left, top, right, bottom } = labelBounds
      return nodeX >= left && nodeX <= right && nodeY >= top && nodeY <= bottom
    }

    const drawNode = (node: ExploreNode, ctx: CanvasRenderingContext2D, scale: number): void => {
      const palette = paletteRef.current
      if (palette === null || node.x === undefined || node.y === undefined) {
        return
      }
      const current = anchor()
      const lit = isLit(node.id)
      ctx.globalAlpha = current !== null && !lit ? 0.15 : 1
      ctx.beginPath()
      ctx.arc(node.x, node.y, radius(node), 0, 2 * Math.PI)
      ctx.fillStyle =
        node.id === current ? palette.anchor : node.daily ? palette.daily : palette.note
      ctx.fill()
      if ((scale > LABEL_ZOOM || lit) && inLabelBounds(node.x, node.y)) {
        ctx.font = labelFont
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillStyle = palette.label
        ctx.fillText(node.title, node.x, node.y + radius(node) + 2 / scale)
      }
      ctx.globalAlpha = 1
    }

    const worker = new Worker(new URL('./explore-layout.worker.ts', import.meta.url), {
      type: 'module',
    })
    workerRef.current = worker
    const send = (message: ToLayoutWorker): void => worker.postMessage(message)

    const instance: ExploreGraph = new ForceGraph<ExploreNode, ExploreLink>(container)
      .nodeId('id')
      // Titles are drawn on the canvas; force-graph's own tooltip is off.
      .nodeLabel(() => '')
      .nodeCanvasObject(drawNode)
      .nodePointerAreaPaint((node, color, ctx) => {
        if (node.x === undefined || node.y === undefined) {
          return
        }
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(node.x, node.y, radius(node) + 2, 0, 2 * Math.PI)
        ctx.fill()
      })
      // Links aren't interactive. Without this, force-graph repaints every link
      // in its own colour on a hidden hit-testing canvas several times a
      // second, which stalls frames for 100–250ms on a large graph.
      .linkPointerAreaPaint(skipLinkHitArea)
      // While a note is highlighted only its own links are drawn, so the rest
      // aren't stroked at all.
      .linkVisibility((link) => anchor() === null || touchesAnchor(link))
      .linkColor(() => {
        const palette = paletteRef.current
        if (palette === null) {
          return 'transparent'
        }
        return anchor() === null ? palette.link : palette.linkHighlight
      })
      .linkWidth(() => (anchor() === null ? 0.5 : 1.5))
      .onRenderFramePre((_ctx, scale) => prepareFrame(scale))
      // The worker owns the layout: force-graph's own simulation never steps,
      // and only its link force stays, to resolve link ends to nodes.
      .cooldownTicks(0)
      .d3Force('charge', null)
      .d3Force('center', null)
      .onNodeHover((node) => {
        hoveredRef.current = node?.id ?? null
        requestRedraw(instance)
      })
      .onNodeDrag((node) => {
        if (node.fx !== undefined && node.fy !== undefined) {
          send({ type: 'drag', id: node.id, x: node.fx, y: node.fy })
        }
      })
      .onNodeDragEnd((node) => send({ type: 'release', id: node.id }))
      .onNodeClick((node, event) => openNote(node.id, event))
    instanceRef.current = instance

    const applyPositions = (event: MessageEvent<unknown>): void => {
      const parsed = fromLayoutWorkerSchema.safeParse(event.data)
      if (!parsed.success) {
        failedRef.current = true
        setLayoutError(new Error(UNREADABLE_POSITIONS, { cause: parsed.error }))
        return
      }
      const message = parsed.data
      // The worker is still laying out, so an earlier failure has passed.
      if (failedRef.current) {
        failedRef.current = false
        setLayoutError(null)
      }
      if (message.generation !== generationRef.current) {
        return
      }
      const { positions } = message
      for (const [index, node] of orderRef.current.entries()) {
        const positionX = positions[index * 2]
        const positionY = positions[index * 2 + 1]
        // A note under the pointer stays where force-graph's drag put it.
        if (node.fx === undefined && positionX !== undefined && positionY !== undefined) {
          node.x = positionX
          node.y = positionY
        }
      }
      requestRedraw(instance)
      if (followRef.current && orderRef.current.length > 0) {
        instance.zoomToFit(0, 40)
        followRef.current = !message.settled
      }
    }
    worker.addEventListener('message', applyPositions)
    const failLayout = (event: ErrorEvent): void => {
      failedRef.current = true
      // WebKit leaves the message empty when the worker script fails to load.
      setLayoutError(new Error(event.message === '' ? 'The layout stopped.' : event.message))
    }
    const failMessage = (): void => {
      failedRef.current = true
      setLayoutError(new Error(UNREADABLE_POSITIONS))
    }
    worker.addEventListener('error', failLayout)
    worker.addEventListener('messageerror', failMessage)

    // Panning, zooming or dragging takes the camera over from the fit.
    const stopFollowing = (): void => {
      followRef.current = false
    }
    container.addEventListener('pointerdown', stopFollowing, { capture: true })
    container.addEventListener('wheel', stopFollowing, { capture: true, passive: true })

    const resize = new ResizeObserver(() => {
      instance.width(container.clientWidth).height(container.clientHeight)
    })
    resize.observe(container)

    return () => {
      resize.disconnect()
      container.removeEventListener('pointerdown', stopFollowing, { capture: true })
      container.removeEventListener('wheel', stopFollowing, { capture: true })
      worker.removeEventListener('message', applyPositions)
      worker.removeEventListener('error', failLayout)
      worker.removeEventListener('messageerror', failMessage)
      worker.terminate()
      workerRef.current = null
      instance._destructor()
      instanceRef.current = null
      laidOutRef.current = null
      fitKeyRef.current = null
      knownRef.current = new Map()
    }
  }, [container])

  // Re-resolve the colour tokens when the theme changes. `ThemeEffect` sits
  // above the screens, so its effect has already applied the theme.
  useEffect(() => {
    const instance = instanceRef.current
    if (container === null || instance === null) {
      return
    }
    paletteRef.current = readExplorePalette(container)
    requestRedraw(instance)
  }, [resolvedTheme, container])

  useEffect(() => {
    const instance = instanceRef.current
    const worker = workerRef.current
    if (instance === null || worker === null) {
      return
    }
    const known = knownRef.current
    const next = new Map<string, ExploreNode>()
    for (const { path, title, daily, degree } of graph.nodes) {
      const node = Object.assign(known.get(path) ?? { id: path }, { title, daily, degree })
      known.set(path, node)
      next.set(path, node)
    }
    nodesRef.current = next
    neighboursRef.current = graph.neighbours
    if (hoveredRef.current !== null && !next.has(hoveredRef.current)) {
      hoveredRef.current = null
    }

    // Most index refreshes (an edit that adds no link) leave the shape alone,
    // and there is nothing to lay out again. Nor is there anything to fit to,
    // even if the filters changed.
    const refit = fitKey !== fitKeyRef.current
    if (laidOutRef.current !== null && sameShape(laidOutRef.current, graph)) {
      fitKeyRef.current = fitKey
      requestRedraw(instance)
      return
    }
    laidOutRef.current = graph
    if (graph.nodes.length > 0) {
      fitKeyRef.current = fitKey
      followRef.current ||= refit
    }
    const seeded = seedNearNeighbours(
      [...next.values()].filter((node) => node.x === undefined),
      next,
      graph.neighbours,
    )
    const order = [...next.values()]
    orderRef.current = order
    generationRef.current += 1
    instance.graphData({
      nodes: order,
      links: graph.links.map(({ source, target }) => ({ source, target })),
    })
    const message: ToLayoutWorker = {
      type: 'graph',
      generation: generationRef.current,
      // Unplaced notes get d3's starting spiral in the worker.
      nodes: order.map((node) => ({
        id: node.id,
        x: node.x,
        y: node.y,
        seeded: seeded.has(node),
      })),
      // postMessage copies these; force-graph needs its own, as it rewrites
      // link ends into node references.
      links: graph.links,
    }
    worker.postMessage(message)
  }, [graph, fitKey, container])

  useEffect(() => {
    selectedRef.current = selected
    const instance = instanceRef.current
    if (instance !== null) {
      requestRedraw(instance)
    }
  }, [selected])

  const focusNote = useCallback((path: string) => {
    const instance = instanceRef.current
    const node = nodesRef.current.get(path)
    if (instance === null || node?.x === undefined || node.y === undefined) {
      return
    }
    // The user chose where to look; the layout's fit must not undo it.
    followRef.current = false
    instance.centerAt(node.x, node.y, 600)
    instance.zoom(Math.max(instance.zoom(), 4), 600)
  }, [])

  return { focusNote, layoutError }
}

/**
 * Whether two graphs draw the same notes and links, in the same order.
 */
function sameShape(previous: VisibleGraph, next: VisibleGraph): boolean {
  return (
    previous.nodes.length === next.nodes.length &&
    previous.links.length === next.links.length &&
    previous.nodes.every((node, index) => node.path === next.nodes[index]?.path) &&
    previous.links.every((link, index) => {
      const other = next.links[index]
      return link.source === other?.source && link.target === other.target
    })
  )
}

/**
 * Start newly shown notes beside the placed notes they link to, so revealing
 * daily notes settles quickly instead of exploding out of the default spiral.
 * A new note placed this way can seed the new notes linked to it in turn, so
 * daily notes that only link to each other are placed too. Returns the notes
 * it placed.
 */
function seedNearNeighbours(
  fresh: readonly ExploreNode[],
  nodes: ReadonlyMap<string, ExploreNode>,
  neighbours: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<ExploreNode> {
  const seeded = new Set<ExploreNode>()
  const pending = new Set(fresh)
  const queue = [...fresh]
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]!
    if (!pending.has(node) || !placeNearNeighbours(node, neighbours.get(node.id), nodes)) {
      continue
    }
    pending.delete(node)
    seeded.add(node)
    for (const path of neighbours.get(node.id) ?? []) {
      const neighbour = nodes.get(path)
      if (neighbour !== undefined && pending.has(neighbour)) {
        queue.push(neighbour)
      }
    }
  }
  return seeded
}

/**
 * Start a note beside the placed notes it links to. Returns whether any were
 * placed.
 */
function placeNearNeighbours(
  node: ExploreNode,
  neighbours: ReadonlySet<string> | undefined,
  placed: ReadonlyMap<string, ExploreNode>,
): boolean {
  let sumX = 0
  let sumY = 0
  let count = 0
  for (const path of neighbours ?? []) {
    const neighbour = placed.get(path)
    if (neighbour?.x !== undefined && neighbour.y !== undefined) {
      sumX += neighbour.x
      sumY += neighbour.y
      count++
    }
  }
  if (count === 0) {
    return false
  }
  node.x = sumX / count + (Math.random() - 0.5) * SEED_SPREAD
  node.y = sumY / count + (Math.random() - 0.5) * SEED_SPREAD
  return true
}

function skipLinkHitArea(): void {
  // Deliberately paints nothing; see `linkPointerAreaPaint` above.
}

function endpointId(end: ExploreLink['source']): string | number | undefined {
  return typeof end === 'object' ? end.id : end
}

/**
 * Once the layout settles, force-graph only repaints when told to, and a
 * hover change alone doesn't tell it. Re-setting a canvas accessor does.
 */
function requestRedraw(instance: ExploreGraph): void {
  instance.nodeCanvasObject(instance.nodeCanvasObject())
}
