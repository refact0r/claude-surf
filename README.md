# claude-surf

A Claude Code mod that plays Subway Surfers in a pane next to your conversation.

`/surf` opens the web version of the game in a private headless Chrome and streams it into the
terminal. In Ghostty or kitty the pane shows a real picture; elsewhere it falls back to colored
text characters. `/surf <file or URL>` plays a video instead.

## Requirements

Tested on macOS with Claude Code 2.1.286. The mod API is early access and may change.

- Node 22+
- Chrome, Chromium, Brave or Edge
- ffmpeg, only for videos
- Ghostty or kitty for the picture views

## Run

```sh
git clone https://github.com/refact0r/claude-surf
claude --plugin-dir ./claude-surf
```

Then type `/surf`. `/surf stop` or `q` ends it.

## Keys

Click the pane (or press ctrl+x tab) to give it the keyboard.

| key | |
| --- | --- |
| `a` `d` | change lanes |
| `w` `s` | jump, roll |
| `e` | start / new round (sends space) |
| `v` | view: full color, ascii, characters |
| `q` | quit |

## Options

`url`, `style` (`ascii`, `blocks`, `braille`) and `sound` show up in `/config`.

## How it works

`bin/surf.mjs` drives Chrome over the DevTools protocol and takes its screencast frames. For the
picture views it writes each frame to a raw RGB file that the terminal reads through the kitty
graphics protocol: the frame itself in full color, or the frame redrawn as small ascii glyphs. The
characters view sends a grid of terminal cells instead. Glyph art picks, for each cell, the glyph
and the foreground and background colors that best match that patch of the frame.
`hooks/register.tsx` is the pane, drawn with the mod API's `Image` and `Raster` elements.

Game progress is kept in `~/Library/Caches/claude-subway-surfer/chrome-profile`, so you only see
the tutorial once. Nothing runs while the pane is closed.

## Tests

```sh
claude plugin validate .
claude plugin test .
```

Subway Surfers belongs to SYBO. This repo contains none of the game; it loads the official web
version on Poki.
