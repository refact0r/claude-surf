# claude-surf

play subway surfers in claude code.

https://github.com/user-attachments/assets/c3255733-d792-4186-a759-73c2a34e0f6a

`/surf` opens the web version of the game in a headless chrome and draws it in a pane next to your chat. requires kitty graphics protocol for full res/color. `/surf <file or url>` plays a video instead.

## run

```sh
git clone https://github.com/refact0r/claude-surf
claude --plugin-dir ./claude-surf
```

then type `/surf`. needs node 22+, chrome (or chromium, brave, edge), and ffmpeg for videos. only tested on macos with claude code 2.1.286.

## keys

click the pane first (or ctrl+x tab).

- `a` `d` change lanes
- `w` `s` jump, roll
- `e` start / new round
- `v` switch view (full color, ascii, text)
- `q` quit

your progress is saved in `~/Library/Caches/claude-subway-surfer/chrome-profile`. nothing runs while the pane is closed.

Subway Surfers belongs to SYBO. This repo does not contain the game, it loads the web version on Poki.
