import type { MaybePromise } from '@reflect/utils'
import type { DatabaseService } from './database-service.ts'

/**
 * One note in the {@link NoteGraph}.
 */
export interface NoteGraphNode {
  readonly path: string
  readonly title: string
  /**
   * A daily note. Explore hides these by default; they swamp the layout.
   */
  readonly daily: boolean
}

/**
 * One resolved link, deduplicated per source/target pair. Self-links are dropped.
 */
export interface NoteGraphLink {
  readonly source: string
  readonly target: string
}

/**
 * The note graph the Explore screen draws (Plan 25): every non-template note
 * with at least one link, and the resolved links between them. Private notes are included — this is
 * a local view of the user's own graph, the same exposure as All Notes, and
 * nothing here leaves the device.
 */
export interface NoteGraph {
  readonly nodes: readonly NoteGraphNode[]
  readonly links: readonly NoteGraphLink[]
}

export interface NoteGraphServiceDeps {
  readonly database: DatabaseService
}

/**
 * The whole-graph projection behind the Explore screen.
 */
export interface NoteGraphService {
  /**
   * Load the active graph's {@link NoteGraph} from the index.
   */
  loadNoteGraph(): MaybePromise<NoteGraph>
}

class NoteGraphServiceImpl implements NoteGraphService {
  readonly #deps: NoteGraphServiceDeps

  constructor(deps: NoteGraphServiceDeps) {
    this.#deps = deps
  }

  async loadNoteGraph(): Promise<NoteGraph> {
    const { db } = this.#deps.database
    const [nodes, links] = await Promise.all([
      db
        .selectFrom('notes')
        .where('kind', '!=', 'template')
        .select(['path', 'title', 'kind'])
        .orderBy('path')
        .execute(),
      // The view already excludes templates on both ends, so every row
      // joins a note above.
      db
        .selectFrom('backlinks')
        .select(['sourcePath as source', 'targetPath as target'])
        .$narrowType<{ source: string; target: string }>()
        .distinct()
        .whereRef('sourcePath', '!=', 'targetPath')
        .orderBy('sourcePath')
        .orderBy('targetPath')
        .execute(),
    ])
    // Explore never draws an unlinked note. The view resolves links at query
    // time, so this is cheaper here than as a per-note subquery.
    const linked = new Set(links.flatMap(({ source, target }) => [source, target]))
    return {
      nodes: nodes
        .filter(({ path }) => linked.has(path))
        .map(({ path, title, kind }) => ({ path, title, daily: kind === 'daily' })),
      links,
    }
  }
}

/**
 * Create the {@link NoteGraphService} over the index database.
 */
export function createNoteGraphService(deps: NoteGraphServiceDeps): NoteGraphService {
  return new NoteGraphServiceImpl(deps)
}
