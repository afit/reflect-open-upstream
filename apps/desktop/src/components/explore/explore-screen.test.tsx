import { createTestCoreServices } from '@reflect/core/testing'
import type { NoteGraph } from '@reflect/core'
import { userEvent } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { ExploreScreen } from './explore-screen.tsx'

// Canvas hit-testing (hover, click, drag) belongs to force-graph and isn't
// exercised here; these cover the data plumbing and the keyboard path.
const GRAPH: NoteGraph = {
  nodes: [
    { path: 'daily/2026-01-02.md', title: '2026-01-02', daily: true },
    { path: 'notes/alpha.md', title: 'Alpha', daily: false },
    { path: 'notes/beta.md', title: 'Beta', daily: false },
    { path: 'notes/lonely.md', title: 'Lonely', daily: false },
  ],
  links: [
    { source: 'notes/alpha.md', target: 'notes/beta.md' },
    { source: 'daily/2026-01-02.md', target: 'notes/beta.md' },
  ],
}

async function renderScreen(graph: NoteGraph = GRAPH) {
  const core = createTestCoreServices({ database: createWasmTestDatabaseService() })
  vi.spyOn(core.noteGraph, 'loadNoteGraph').mockResolvedValue(graph)
  return await renderInApp(
    <div style={{ height: '100vh' }}>
      <ExploreScreen />
    </div>,
    { core, graph: { root: '/g', name: 'g', generation: 1 }, route: { kind: 'explore' } },
  )
}

describe('ExploreScreen', () => {
  it('draws linked notes without daily notes, with search focused', async () => {
    const view = await renderScreen()

    await expect.element(view.getByText('2 notes · 1 link')).toBeInTheDocument()
    await expect.element(view.getByRole('textbox', { name: 'Find a note' })).toHaveFocus()
    const canvasHost = view.getByTestId('explore-canvas')
    await expect.poll(() => canvasHost.element().querySelector('canvas')).not.toBeNull()
  })

  it('adds daily notes and their links when the toggle is on', async () => {
    const view = await renderScreen()

    await view.getByRole('switch', { name: 'Daily notes' }).click()

    await expect.element(view.getByText('3 notes · 2 links')).toBeInTheDocument()
  })

  it('opens the searched note on a second Return', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('2 notes · 1 link')).toBeInTheDocument()

    await userEvent.keyboard('bet{Enter}')
    expect(view.appServices.navigation.getState().route).toEqual({ kind: 'explore' })

    await userEvent.keyboard('{Enter}')
    await expect
      .poll(() => view.appServices.navigation.getState().route)
      .toEqual({ kind: 'note', path: 'notes/beta.md' })
  })

  it('leaves Return to an IME composition', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('2 notes · 1 link')).toBeInTheDocument()
    await userEvent.keyboard('bet{Enter}')

    view
      .getByRole('textbox', { name: 'Find a note' })
      .element()
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
      )

    expect(view.appServices.navigation.getState().route).toEqual({ kind: 'explore' })
  })

  it('keeps the map when a background refresh fails', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('2 notes · 1 link')).toBeInTheDocument()
    vi.spyOn(view.core.noteGraph, 'loadNoteGraph').mockRejectedValue(new Error('index busy'))

    await view.queryClient.refetchQueries()

    expect(view.getByText(/Couldn't load/).query()).toBeNull()
    await expect.element(view.getByText('2 notes · 1 link')).toBeInTheDocument()
  })

  it('points to the toggle when every link goes through a daily note', async () => {
    const view = await renderScreen({
      nodes: GRAPH.nodes,
      links: [{ source: 'daily/2026-01-02.md', target: 'notes/beta.md' }],
    })

    await expect.element(view.getByText(/Turn on Daily notes to see them/)).toBeInTheDocument()
  })

  it('reports a failed load instead of an empty map', async () => {
    const core = createTestCoreServices({ database: createWasmTestDatabaseService() })
    vi.spyOn(core.noteGraph, 'loadNoteGraph').mockRejectedValue(new Error('index unavailable'))
    const view = await renderInApp(<ExploreScreen />, {
      core,
      graph: { root: '/g', name: 'g', generation: 1 },
      route: { kind: 'explore' },
    })

    await expect
      .element(view.getByText("Couldn't load your notes' links: index unavailable"))
      .toBeInTheDocument()
  })

  it('explains an empty map', async () => {
    const view = await renderScreen({ nodes: GRAPH.nodes, links: [] })

    await expect.element(view.getByText(/No linked notes yet/)).toBeInTheDocument()
  })
})
