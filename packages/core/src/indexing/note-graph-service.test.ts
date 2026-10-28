import { describe, expect, it } from 'vitest'
import { createNodeTestDatabaseService, seedNotes } from '../testing/database.ts'
import { createNoteGraphService } from './note-graph-service.ts'

describe('loadNoteGraph', () => {
  it('returns linked non-template notes, private ones included, and their deduplicated, resolved links', async () => {
    const database = createNodeTestDatabaseService()
    seedNotes(database, [
      { path: 'notes/a.md', markdown: '# A\n[[B]] and [[B]] again, [[Nowhere]], [[A]]\n' },
      { path: 'notes/b.md', markdown: '# B\nBack to [[A]]\n' },
      { path: 'notes/c.md', markdown: '# C\n' },
      { path: 'notes/lonely.md', markdown: '# Lonely\n' },
      { path: 'notes/secret.md', markdown: '---\nprivate: true\n---\n# Secret\n[[C]]\n' },
      { path: 'daily/2026-01-02.md', markdown: 'Met [[B]]\n' },
      { path: 'templates/meeting.md', markdown: '# Meeting\n[[A]]\n' },
    ])

    await expect(createNoteGraphService({ database }).loadNoteGraph()).resolves.toEqual({
      nodes: [
        { path: 'daily/2026-01-02.md', title: '2026-01-02', daily: true },
        { path: 'notes/a.md', title: 'A', daily: false },
        { path: 'notes/b.md', title: 'B', daily: false },
        { path: 'notes/c.md', title: 'C', daily: false },
        { path: 'notes/secret.md', title: 'Secret', daily: false },
      ],
      links: [
        { source: 'daily/2026-01-02.md', target: 'notes/b.md' },
        { source: 'notes/a.md', target: 'notes/b.md' },
        { source: 'notes/b.md', target: 'notes/a.md' },
        { source: 'notes/secret.md', target: 'notes/c.md' },
      ],
    })
  })

  it('maps an empty graph to no nodes and no links', async () => {
    const database = createNodeTestDatabaseService()

    await expect(createNoteGraphService({ database }).loadNoteGraph()).resolves.toEqual({
      nodes: [],
      links: [],
    })
  })
})
