export type Phase = 'idle' | 'starting' | 'loading' | 'playing' | 'error'

export type Style = 'ascii' | 'blocks' | 'braille'

/**
 * How the terminal shows the game, cycled by `v`: the game's own pixels in
 * full color (the default), a picture of small ascii glyphs (both pictures, by
 * the kitty graphics protocol), or the terminal's own characters.
 */
export type Mode = 'ascii' | 'full' | 'cells'

export type View = {
  phase: Phase
  /** What the frame source last said about itself; empty while all is well. */
  message: string
  /** What is playing, as the pane names it: a host name or a file name. */
  source: string
  style: Style
  mode: Mode
  fps: number
}

declare module 'claude-code' {
  interface PluginState {
    'subway-surfer': { view: View }
  }
}
