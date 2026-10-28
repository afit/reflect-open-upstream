import type { ComponentProps, ReactElement } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input.tsx'

export type HeaderSearchInputProps = Omit<ComponentProps<'input'>, 'className'>

/**
 * The borderless search field that fills a screen header (Tasks, Explore):
 * a magnifier glyph and an unframed input. Grows to the header's free width.
 */
export function HeaderSearchInput(props: HeaderSearchInputProps): ReactElement {
  return (
    <div className="window-drag-control min-w-0 flex-1">
      <Search
        aria-hidden
        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-muted"
      />
      <Input
        {...props}
        className="h-9 border-none bg-transparent pl-8 shadow-none focus-visible:ring-0"
      />
    </div>
  )
}
