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

**The toolbar button** only deals with the site in the current tab:

- **Hide video lengths on this site**: switch it on or off for this site.
- **Show the dialog when a video starts**: whether this site asks first.
- **Open dashboard**: everything else.

**The dialog.** With auto-detect on, a dialog appears in the page when a video
starts playing: the length is already hidden, and **Cancel** shows the real
one for that video (or let it close by itself to keep the guard). Two options
remember the button you press so the dialog stops appearing:

- **Don't show this again – for this session**: for this website, until you
  close the browser.
- **Don't show this again – for this website**: for this website, from now on.
  Keep hidden means it is guarded without asking; Cancel switches it off.

**The dashboard** (toolbar button → Open dashboard) holds everything else:

- **Auto-detect all video playbacks and automatically apply**: guards every
  video that starts playing on any site that isn't switched off, with the
  dialog. When it's off, only the sites switched on are guarded, silently.
- **This browser session**: the session choices you made in the dialog, with
  a way to forget them.
- **Sites**: a switch for each built-in site (YouTube, Twitch, Kick, Vimeo,
  Dailymotion, Rumble, Netflix, Prime Video, HBO Max, Hulu, Crunchyroll,
  Paramount+, Peacock, Facebook, X, Reddit, TikTok, Bilibili) and every site
  you added, each with its dialog and progress-bar options. A site's setting
  also covers videos embedded in its pages.
- **Add a site**: a domain such as `example.com` or a link to a video page.
  Subdomains are included.
- The range of fake time (default 2 to 6 hours), new fake lengths for every
  video, how long the dialog waits, and which short videos to ignore.
- CSS selectors for an added site's duration label or progress bar, for
  players the automatic detection misses.

The toolbar button shows **ON** on tabs where a video is being guarded.

## How it works

The content script reads the real length from the `<video>` element and
rewrites any clock in the player that shows it (for example `0:12:34 / 1:02:05`
becomes `0:12:34 / 4:39:51`), along with time-remaining clocks such as
`-49:31`. It reacts to the player's own updates before the browser paints, so
the real length never flashes, including while a player reloads its video,
switches quality, moves the video into a mini-player or goes fullscreen. For the
built-in sites it also knows each player's own length label, progress bar and
ad markers; during an ad it leaves the ad's own clock alone. Turning the guard
off puts the original text back.

Finding players inside web components means walking the page, so that walk runs
in slices of a few milliseconds and less often (up to every 30 seconds) on pages
where it keeps finding nothing, so large pages don't stutter.

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
node --test tests/*.test.mjs                                # pure logic
NODE_PATH="$(npm root -g)" node tests/e2e.cjs               # real Chromium; needs Playwright and ffmpeg
NODE_PATH="$(npm root -g)" node tests/e2e-regressions.cjs   # one check per problem found in review
```
