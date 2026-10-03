# claude-surf

play subway surfers in claude code.

`/surf` opens the web version of the game in a headless chrome and draws it in a pane next to your chat. full color in ghostty or kitty, colored text everywhere else. `/surf <file or url>` plays a video instead.

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

subway surfers belongs to sybo. this repo doesn't include the game, it just loads the official web version on poki.
