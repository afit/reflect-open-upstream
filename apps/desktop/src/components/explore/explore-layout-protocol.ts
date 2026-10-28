import { z } from 'zod'

/**
 * Messages between the Explore screen and its layout worker. Each new graph
 * carries a generation, and positions echo it back, so positions computed for
 * a graph the screen has since replaced are dropped.
 */

const layoutNodeSchema = z.object({
  id: z.string(),
  x: z.number().optional(),
  y: z.number().optional(),
  seeded: z.boolean().optional(),
})

const layoutLinkSchema = z.object({ source: z.string(), target: z.string() })

export const toLayoutWorkerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('graph'),
    generation: z.number(),
    nodes: z.array(layoutNodeSchema),
    links: z.array(layoutLinkSchema).readonly(),
  }),
  z.object({ type: z.literal('drag'), id: z.string(), x: z.number(), y: z.number() }),
  z.object({ type: z.literal('release'), id: z.string() }),
])

export type ToLayoutWorker = z.infer<typeof toLayoutWorkerSchema>

export const fromLayoutWorkerSchema = z.object({
  type: z.literal('positions'),
  generation: z.number(),
  /** `[x0, y0, x1, y1, …]` in the order of the graph message's nodes. */
  positions: z.instanceof(Float32Array),
  /** The layout has stopped moving; nothing more comes until the next message. */
  settled: z.boolean(),
})

export type FromLayoutWorker = z.infer<typeof fromLayoutWorkerSchema>
