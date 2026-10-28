import type { NoteGraph } from '@reflect/core'
import { describe, expect, it } from 'vitest'
import { findNoteByTitle, visibleGraph } from './explore-graph-data.ts'

const graph: NoteGraph = {
  nodes: [
    { path: 'daily/2026-01-02.md', title: '2026-01-02', daily: true },
    { path: 'notes/a.md', title: 'Alpha', daily: false },
    { path: 'notes/b.md', title: 'Beta', daily: false },
    { path: 'notes/c.md', title: 'Gamma', daily: false },
    { path: 'notes/lonely.md', title: 'Lonely', daily: false },
  ],
  links: [
    { source: 'daily/2026-01-02.md', target: 'notes/b.md' },
    { source: 'daily/2026-01-02.md', target: 'notes/c.md' },
    { source: 'notes/a.md', target: 'notes/b.md' },
  ],
}

describe('visibleGraph', () => {
  it('counts degree among the notes shown', () => {
    const hidden = visibleGraph(graph, { showDaily: false })
    const shown = visibleGraph(graph, { showDaily: true })

    expect(hidden.nodes.find((node) => node.path === 'notes/b.md')?.degree).toBe(1)
    expect(shown.nodes.find((node) => node.path === 'notes/b.md')?.degree).toBe(2)
  })

  it('hides daily notes and any note they leave unlinked', () => {
    const visible = visibleGraph(graph, { showDaily: false })

    expect(visible.nodes.map((node) => node.path)).toEqual(['notes/a.md', 'notes/b.md'])
    expect(visible.links).toEqual([{ source: 'notes/a.md', target: 'notes/b.md' }])
    expect(visible.neighbours.get('notes/b.md')).toEqual(new Set(['notes/a.md']))
  })

  it('shows daily notes when asked, still dropping notes with no links', () => {
    const visible = visibleGraph(graph, { showDaily: true })

    expect(visible.nodes.map((node) => node.path)).toEqual([
      'daily/2026-01-02.md',
      'notes/a.md',
      'notes/b.md',
      'notes/c.md',
    ])
    expect(visible.links).toHaveLength(3)
    expect(visible.neighbours.get('notes/b.md')).toEqual(
      new Set(['daily/2026-01-02.md', 'notes/a.md']),
    )
  })

  it('draws notes that link to each other with one link', () => {
    const visible = visibleGraph(
      { ...graph, links: [...graph.links, { source: 'notes/b.md', target: 'notes/a.md' }] },
      { showDaily: false },
    )

    expect(visible.links).toEqual([{ source: 'notes/a.md', target: 'notes/b.md' }])
  })
})

describe('findNoteByTitle', () => {
  it('prefers an exact match, then a prefix, then a substring', () => {
    const nodes = [
      { path: 'notes/x.md', title: 'Project notes', daily: false, degree: 9 },
      { path: 'notes/y.md', title: 'Notes', daily: false, degree: 1 },
      { path: 'notes/z.md', title: 'Notebook', daily: false, degree: 5 },
    ]

    expect(findNoteByTitle(nodes, 'notes')?.path).toBe('notes/y.md')
    expect(findNoteByTitle(nodes, 'note')?.path).toBe('notes/z.md')
    expect(findNoteByTitle(nodes, 'ject')?.path).toBe('notes/x.md')
  })

  it('breaks a tie towards the most-linked note', () => {
    const nodes = [
      { path: 'notes/a.md', title: 'Plan A', daily: false, degree: 1 },
      { path: 'notes/b.md', title: 'Plan B', daily: false, degree: 4 },
    ]

    expect(findNoteByTitle(nodes, 'plan')?.path).toBe('notes/b.md')
  })

  it('returns null for a blank query or no match', () => {
    const { nodes } = visibleGraph(graph, { showDaily: true })

    expect(findNoteByTitle(nodes, '  ')).toBeNull()
    expect(findNoteByTitle(nodes, 'zzz')).toBeNull()
  })
})
