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

- **This site**: On, Off or Default for the site in the current tab. Default
  hands an added site back to auto-detect. When the site is on, you can also
  choose whether it shows the dialog.
- **Auto-detect all video playbacks and automatically apply**: when a video
  starts playing on any site that isn't switched off, the guard turns on and a
  dialog appears in the page. Choose **Cancel** to see the real length for
  that video, or let it close by itself to keep the guard on. Tick **Remember
  my choice** to stop being asked on that site (Keep) or to switch the site
  off (Cancel). With auto-detect off, only the sites switched on in the list
  are guarded, with no dialog.
- **Sites**: a switch for each built-in site (YouTube, Twitch, Kick, Vimeo,
  Dailymotion, Rumble, Netflix, Prime Video, HBO Max, Hulu, Crunchyroll,
  Paramount+, Peacock, Facebook, X, Reddit, TikTok, Bilibili) and every site
  you added. Sites that are off are never touched. A site's setting also
  covers videos embedded in its pages, so switching a blog off also leaves its
  YouTube embeds alone.
- **Add a site**: type a domain such as `example.com` or paste a link to a video
  page. Subdomains are included.

**All settings** opens the options page, where you can also:

- change the range of fake time (default 2 to 6 hours),
- pick new fake lengths for every video,
- set how long the dialog waits before closing itself, and ignore short videos
  (default: under 1 minute, which skips most ads and previews),
- choose per site whether the dialog appears,
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
the real length never flashes, including while a player reloads its video or
switches quality. For the built-in sites it also knows each player's own length
label, progress bar and ad markers. During an ad it steps aside and comes back
when the video resumes. Turning the guard off puts the original text back.

The fake time for each video comes from a hash of the video's ID and a random
value stored only on your computer. Nothing is sent anywhere. The extension has
no network code.

## What it can't hide

- The progress bar's position, unless you turn on hiding it for that site.
- Lengths printed on thumbnails, in search results and in chapter lists.
- Players that draw their controls in a canvas, and the browser's built-in
  video controls (their shadow UI can't be reached by extensions).
- Disney+: its player doesn't report the video's length to the page, so it
  isn't in the list.
- Clocks written with non-Latin digits, or split across several elements
  digit by digit.

## Permissions

- **Read and change data on all websites**: needed to find and rewrite video
  players on any site, which is what auto-detect does.
- **Storage**: your settings, synced through your Chrome profile.
- **Scripting**: starts the guard in tabs that were already open when the
  extension was installed or updated, so you don't have to reload them.

## Tests

```sh
node --test tests/*.test.mjs          # pure logic
NODE_PATH="$(npm root -g)" node tests/e2e.cjs   # real Chromium; needs Playwright and ffmpeg
```
