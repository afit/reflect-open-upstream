import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { isModEvent } from '@meowdown/core'
import { HeaderSearchInput } from '@/components/header-search-input.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { useNoteLinkNavigation, type ModClickEvent } from '@/hooks/use-note-link-navigation.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { routeForPath } from '@/routing/route.ts'
import { useCoreServices } from '@/services/services-provider.tsx'
import { findNoteByTitle, visibleGraph, type VisibleGraph } from './explore-graph-data.ts'
import { useForceGraph } from './use-force-graph.ts'

const EMPTY_GRAPH: VisibleGraph = { nodes: [], links: [], neighbours: new Map() }

/**
 * The Explore screen (Plan 25): the graph's notes and resolved links as a
 * force-directed map. Drag to pan, scroll to zoom, hover to light a note's
 * neighbourhood, click to open (⌘-click for a new window).
 *
 * Search is focused on arrival: Return finds and centres the best title
 * match, a second Return opens it, Esc clears.
 */
export function ExploreScreen(): ReactElement {
  const { graph } = useGraph()
  const { noteGraph } = useCoreServices()
  const navigateNoteLink = useNoteLinkNavigation()
  const dailyLabelId = useId()
  const searchRef = useRef<HTMLInputElement>(null)
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null)
  const [showDaily, setShowDaily] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const { data, error } = useQuery({
    queryKey: queryKeys.index.noteGraph(graph?.root),
    queryFn: () => noteGraph.loadNoteGraph(),
    enabled: graph !== null,
  })
  const visible = useMemo(
    () => (data === undefined ? EMPTY_GRAPH : visibleGraph(data, { showDaily })),
    [data, showDaily],
  )
  // A selection hidden by the daily toggle, or gone after a refresh, would
  // dim the whole map around a note that isn't drawn.
  const shownSelected = selected !== null && visible.neighbours.has(selected) ? selected : null

  const openNote = useCallback(
    (path: string, event?: ModClickEvent) => {
      navigateNoteLink({
        target: routeForPath(path),
        openInNewWindow: event !== undefined && isModEvent(event),
      })
    },
    [navigateNoteLink],
  )
  const { focusNote, layoutError } = useForceGraph({
    container: canvas,
    graph: visible,
    selected: shownSelected,
    fitKey: showDaily ? 'daily' : 'notes',
    onOpen: openNote,
  })

  useEffect(() => {
    searchRef.current?.focus({ preventScroll: true })
  }, [])

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // Return and Esc confirm or cancel an IME composition; leave them to it.
    if (event.nativeEvent.isComposing) {
      return
    }
    if (event.key === 'Escape') {
      setQuery('')
      setSelected(null)
      return
    }
    if (event.key !== 'Enter') {
      return
    }
    const match = findNoteByTitle(visible.nodes, query)
    if (match === null) {
      return
    }
    if (match.path === shownSelected) {
      openNote(match.path, event)
      return
    }
    setSelected(match.path)
    focusNote(match.path)
  }

  return (
    <div aria-label="Explore" className="flex h-full min-h-0 flex-col">
      <header className="flex flex-none items-center gap-4 border-b border-border py-2.5 pl-2 pr-4 lg:pl-10">
        <HeaderSearchInput
          ref={searchRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelected(null)
          }}
          onKeyDown={onSearchKeyDown}
          placeholder="Find a note..."
          aria-label="Find a note"
        />
        {data === undefined ? null : (
          <span className="flex-none text-xs tabular-nums text-text-muted">
            {visible.nodes.length} note{visible.nodes.length === 1 ? '' : 's'} ·{' '}
            {visible.links.length} link{visible.links.length === 1 ? '' : 's'}
          </span>
        )}
        <div className="window-drag-control flex flex-none items-center gap-2">
          <span id={dailyLabelId} className="text-xs text-text-muted">
            Daily notes
          </span>
          <Switch
            size="sm"
            aria-labelledby={dailyLabelId}
            checked={showDaily}
            onCheckedChange={setShowDaily}
          />
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        <div
          ref={setCanvas}
          data-testid="explore-canvas"
          className="absolute inset-0 overflow-hidden"
        />
        <ExploreOverlay
          // A failed background refresh leaves the last graph drawn and
          // working, so only a failed first load replaces it.
          loadError={data === undefined ? error : null}
          layoutError={layoutError}
          loading={data === undefined}
          empty={visible.nodes.length === 0}
          hiddenByDaily={!showDaily && (data?.links.length ?? 0) > 0}
        />
      </div>
    </div>
  )
}

interface ExploreOverlayProps {
  loadError: Error | null
  layoutError: Error | null
  loading: boolean
  empty: boolean
  /** Links exist, but every one of them touches a hidden daily note. */
  hiddenByDaily: boolean
}

/**
 * The message over the canvas when there is nothing to draw, or no data yet.
 */
function ExploreOverlay({
  loadError,
  layoutError,
  loading,
  empty,
  hiddenByDaily,
}: ExploreOverlayProps): ReactElement | null {
  let message: string | null = null
  if (loadError !== null) {
    message = `Couldn't load your notes' links: ${loadError.message}`
  } else if (layoutError !== null) {
    message = `Couldn't lay out your notes: ${layoutError.message}`
  } else if (loading) {
    message = 'Loading…'
  } else if (empty) {
    message = hiddenByDaily
      ? 'Your links all go through daily notes. Turn on Daily notes to see them.'
      : 'No linked notes yet. Link notes with [[wiki links]] to see them here.'
  }
  return message === null ? null : (
    <p className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center text-sm text-text-muted">
      {message}
    </p>
  )
}
