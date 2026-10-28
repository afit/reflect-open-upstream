/**
 * The canvas colours for Explore, resolved from design-system tokens so the
 * graph follows the light and dark themes. Canvas can't read CSS variables,
 * so these are concrete colour strings.
 */
export interface ExplorePalette {
  readonly note: string
  readonly daily: string
  readonly anchor: string
  readonly label: string
  readonly link: string
  readonly linkHighlight: string
  readonly font: string
}

/**
 * Resolve the palette against `element`'s computed tokens. Call again after
 * the theme changes.
 */
export function readExplorePalette(element: HTMLElement): ExplorePalette {
  const style = getComputedStyle(element)
  const token = (name: string): string => style.getPropertyValue(name).trim()
  return {
    note: token('--accent'),
    daily: token('--amber-500'),
    anchor: token('--text'),
    label: token('--text-secondary'),
    link: withAlpha(token('--text-muted'), 0.25),
    linkHighlight: withAlpha(token('--accent'), 0.9),
    font: style.fontFamily,
  }
}

let scratch: CanvasRenderingContext2D | null = null

/**
 * `color` at `alpha` opacity. The canvas parser normalizes any CSS colour to
 * `#rrggbb` (or `rgba(…)` when already translucent), which is easy to rewrite.
 */
function withAlpha(color: string, alpha: number): string {
  scratch ??= document.createElement('canvas').getContext('2d')
  if (scratch === null) {
    return color
  }
  scratch.fillStyle = color
  const normalized = scratch.fillStyle
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(normalized)
  if (hex) {
    const [red, green, blue] = hex.slice(1).map((part) => Number.parseInt(part, 16))
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`
  }
  return normalized.replace(/,\s*[\d.]+\)$/, `, ${alpha})`)
}
