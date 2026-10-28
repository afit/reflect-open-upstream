import type { NoteGraph, NoteGraphLink, NoteGraphNode } from '@reflect/core'

export interface ExploreFilters {
  /**
   * Show daily notes. Off by default: they outnumber everything else and
   * pull the layout into one dense ball.
   */
  readonly showDaily: boolean
}

/**
 * A note as Explore draws it.
 */
export interface VisibleNote extends NoteGraphNode {
  /**
   * Distinct notes it links to or from among those shown, so a note linked
   * only from hidden daily notes doesn't draw as a hub.
   */
  readonly degree: number
}

/**
 * The part of the note graph Explore draws, plus an undirected neighbour
 * lookup for hover highlighting.
 */
export interface VisibleGraph {
  readonly nodes: readonly VisibleNote[]
  readonly links: readonly NoteGraphLink[]
  readonly neighbours: ReadonlyMap<string, ReadonlySet<string>>
}

/**
 * Apply the filters, then drop notes left with no visible link: a note linked
 * only from daily notes is unlinked while those are hidden. Notes that link
 * to each other get one link, not two.
 */
export function visibleGraph(graph: NoteGraph, filters: ExploreFilters): VisibleGraph {
  const shown = new Set(
    graph.nodes.filter((node) => filters.showDaily || !node.daily).map((node) => node.path),
  )
  const links: NoteGraphLink[] = []
  const neighbours = new Map<string, Set<string>>()
  for (const link of graph.links) {
    const { source, target } = link
    if (!shown.has(source) || !shown.has(target) || neighbours.get(source)?.has(target)) {
      continue
    }
    links.push(link)
    addNeighbour(neighbours, source, target)
    addNeighbour(neighbours, target, source)
  }
  const nodes: VisibleNote[] = []
  for (const node of graph.nodes) {
    const linked = neighbours.get(node.path)
    if (linked !== undefined) {
      nodes.push({ ...node, degree: linked.size })
    }
  }
  return { nodes, links, neighbours }
}

function addNeighbour(neighbours: Map<string, Set<string>>, from: string, to: string): void {
  const set = neighbours.get(from) ?? new Set<string>()
  set.add(to)
  neighbours.set(from, set)
}

/**
 * The best title match for a search: exact, then prefix, then substring, each
 * case-insensitive; the most-linked note wins a tie. Null for a blank query
 * or no match.
 */
export function findNoteByTitle(nodes: readonly VisibleNote[], query: string): VisibleNote | null {
  const needle = query.trim().toLowerCase()
  if (needle === '') {
    return null
  }
  const rank = (title: string): number => {
    const haystack = title.toLowerCase()
    if (haystack === needle) return 0
    if (haystack.startsWith(needle)) return 1
    if (haystack.includes(needle)) return 2
    return 3
  }
  let best: VisibleNote | null = null
  let bestRank = 3
  for (const node of nodes) {
    const nodeRank = rank(node.title)
    if (
      nodeRank < bestRank ||
      (nodeRank === bestRank && best !== null && node.degree > best.degree)
    ) {
      best = node
      bestRank = nodeRank
    }
  }
  return best
}
