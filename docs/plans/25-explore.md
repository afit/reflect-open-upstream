# Plan 25 — Explore (note graph view)

**Goal:** a desktop screen that draws the graph's notes and their resolved
links as an interactive force-directed map, like Reflect V1's graph and
Obsidian's graph view. It sits in the sidebar under Chat as **Explore**.

**Depends on:** Plan 04 (the `backlinks` view, which already resolves titles,
aliases, dates and path-vs-name readings, and excludes templates), Plan 06
(typed routes), Plan 08 (the command registry).

**Explicitly not in scope:**

- Mobile. Thousands of nodes is too heavy for a phone, and touch needs its
  own interaction design. The route never appears in the mobile tab bar, and
  `MobileScreen`'s fallback already renders Today for it.
- A `reflect://` address. Explore is an in-app surface like Chat, not a place
  worth linking to.
- A dedicated keybinding. The palette's `Explore` command keeps it
  keyboard-reachable; bindings are kept for daily-use surfaces.
- Pinning, a spacing control, neighbourhood focus, a per-note local graph.
  Easy to add later if missed.

## Design

### Data — `NoteGraphService` (`packages/core/src/indexing/note-graph-service.ts`)

`loadNoteGraph()` returns `{ nodes, links }`:

- **Nodes:** every non-template note with at least one link — `path`,
  `title`, `daily`. Private
  notes are included: this is a local view of the user's own graph and
  nothing leaves the device, the same as All Notes.
- **Links:** `SELECT DISTINCT source_path, target_path FROM backlinks`,
  without self-links. Direction is kept but not drawn, so the screen draws
  notes that link to each other with one link.

It is a plain query, like `GraphStatsService`, exposed on `CoreServices`.

### Freshness

The screen reads it through TanStack Query under
`queryKeys.index.noteGraph(root)`, so it refreshes on the same index
invalidation as every other projection. A refresh that changes no drawn note
or link (most edits) only redraws. One that does keeps each surviving note's
position (a note hidden by the toggle and shown again returns to where it
was), starts new notes beside their neighbours, and restarts the layout with
less energy when nearly all notes are placed: least when they were drawn
before, a little more when many were only just started beside their
neighbours. On first load and after the daily-notes toggle the camera
follows the layout, fitting the whole graph, until it settles or the user
pans, zooms or searches; a background refresh never moves it. A failed
refresh keeps the last graph drawn.

### Route and navigation

- `{ kind: 'explore' }` joins `Route`. TypeScript drives the exhaustive
  switches: `routesEqual`, `deepLinkForRoute` (null), the context sidebar
  (no note context) and `RouteContent`.
- `nav.explore` command, no keybinding.
- An **Explore** row under **Chat** in the desktop sidebar.

### Screen (`apps/desktop/src/components/explore/`)

- `explore-screen.tsx` — header, controls, canvas, loading/error/empty
  states; loads the data.
- `explore-graph-data.ts` — pure filtering (daily notes on/off, unlinked
  notes hidden), neighbour lookup, and each note's degree *among the notes
  shown* (so a note linked only from hidden daily notes isn't drawn as a hub).
- `use-force-graph.ts` — owns the `force-graph` canvas: drawing, hover,
  drag, theme colours, teardown. force-graph's own simulation is switched off.
- `explore-layout.ts` + `explore-layout.worker.ts` — the d3-force layout,
  run in a Web Worker. With daily notes shown a large graph is ~8k notes and
  ~30k links, where one layout step costs ~35ms; on the main thread that
  stalled every frame. The worker steps in short slices and posts positions;
  drags are forwarded to it. Messages are Zod-validated
  (`explore-layout-protocol.ts`) and carry a generation so stale positions
  are dropped.

force-graph is also told not to paint link hit areas: links aren't
interactive, and painting 30k uniquely coloured links on its hidden
hit-testing canvas stalled frames by 100–250ms.

Interactions:

- Drag the canvas to pan, scroll to zoom, drag a node to move it.
- Hover highlights a note and its neighbours; labels appear when zoomed in
  or highlighted.
- Click opens the note in place; ⌘-click opens it in a new window
  (`useNoteLinkNavigation`, the Tasks and All Notes convention).
- Search is focused on open; Enter centres on the best title match and
  highlights it, a second Enter opens it, Esc clears.
- A **Daily notes** toggle, off by default (daily notes swamp the layout).

Colours come from design-system tokens read off the document root, and are
re-read when the theme service's resolved theme changes. While a note is
highlighted, links that don't touch it aren't drawn at all, and labels are
only drawn for notes in or near the view.

### Library

`force-graph` (MIT, canvas) for drawing and input, and `d3-force` (ISC) for
the worker's layout, both in `@reflect/desktop`. Bundled, so they work
offline. The screen is lazy-loaded, so neither is in the startup bundle.

## Tests

- `note-graph-service.test.ts` (node): template exclusion, private notes
  included, de-duplication, no self-links.
- `explore-graph-data.test.ts` (node): the filters, visible degree, search
  ranking.
- `explore-layout.test.ts` (node): settling, gentle restart, drag pinning.
- `explore-screen.test.tsx` (browser): renders, search focus and open, the
  daily toggle, empty/hidden-by-daily/error states. Canvas hit-testing is not
  exercised.
