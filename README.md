# Video Spoiler Guard

A Chrome extension that adds a random 2 to 6 hours of fake time to the length a
video player shows, so you can't tell how close the end is. Each video keeps the
same fake length every time you come back to it.

It replaces the earlier Tampermonkey userscript.

## Install

1. Download this repository (Code → Download ZIP) and unzip it, or clone it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the unzipped folder (the one
   with `manifest.json` in it).
4. Pin the extension from the puzzle-piece menu so its toolbar button is handy.

Works in Chrome 116 or newer, and in other Chromium browsers (Edge, Brave, Opera, Vivaldi).

## Using it

Click the toolbar button to open the popup:

- **This site**: On, Off or Auto-detect for the site in the current tab.
- **Auto-detect all video playbacks and automatically apply**: on any site
  that isn't in your list, the guard turns on as soon as a video starts
  playing, and a dialog appears in the page. Choose **Cancel** to see the real
  length for that video, or let it close by itself to keep the guard on. Tick
  **Remember my choice** to add the site to your list as on or off.
- **Sites**: a switch for each built-in site (YouTube, Twitch, Kick, Vimeo,
  Dailymotion, Rumble, Netflix, Prime Video, Disney+, Max, Hulu, Crunchyroll,
  Paramount+, Peacock, Facebook, X, Reddit, Bilibili) and every site you added.
  Sites that are on are guarded without a dialog. Sites that are off are never
  touched, even with auto-detect on.
- **Add a site**: type a domain such as `example.com` or paste a link to a video
  page. Subdomains are included.

**All settings** opens the options page, where you can also:

- change the range of fake time (default 2 to 6 hours),
- pick new fake lengths for every video,
- set how long the dialog waits before closing itself, and ignore short videos
  (default: under 1 minute, which skips most ads and previews),
- hide the progress bar per site, since its position still reflects the real
  length,
- give an added site CSS selectors for its duration label or progress bar, for
  players the automatic detection misses.

The toolbar button shows **ON** on tabs where a video is being guarded.

## How it works

The content script reads the real length from the `<video>` element and
rewrites any clock in the player that shows it (for example `0:12:34 / 1:02:05`
becomes `0:12:34 / 4:39:51`), along with time-remaining clocks such as
`-49:31`. It reacts to the player's own updates before the browser paints, so
the real length never flashes. On YouTube and Twitch it also knows the exact
duration label and progress bar. Turning the guard off puts the original text back.

The fake time for each video comes from a hash of the video's ID and a random
value stored only on your computer. Nothing is sent anywhere. The extension has
no network code.

## What it can't hide

- The progress bar's position, unless you turn on hiding it for that site.
- Lengths printed on thumbnails, in search results and in chapter lists.
- Players that draw their controls in a canvas, and the browser's built-in
  video controls (their shadow UI can't be reached by extensions).

## Permissions

- **Read and change data on all websites**: needed to find and rewrite video
  players on any site, which is what auto-detect does.
- **Storage**: your settings, synced through your Chrome profile.

## Tests

```sh
node --test tests/*.test.mjs          # pure logic
NODE_PATH="$(npm root -g)" node tests/e2e.cjs   # real Chromium; needs Playwright and ffmpeg
```
