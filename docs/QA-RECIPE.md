# QA recipe: It's In There! on Drawdy

Live test setup for the `mingrath1.its-in-there` driver. Verified on 2026-10-17 in worktree `iit-wt/qa` (branch `iit-qa`, based on `651a48f`). Screenshots sit in `docs/qa/`.

## The board

- Board URL: `https://drawdy.io/?local=9dFJUY2k` (local board, titled "Oct 17, 2026").
- Always open the exact URL. The bare `https://drawdy.io/` reopens the most recently used board, which can belong to someone else.
- Do not use `https://drawdy.io/?local=YWasJVp4`. The other team is testing on it.

## Start the dev server

```bash
cd <worktree>
npm install                                  # first time only
npm run dev -- --port 5183
curl -s localhost:5183/version               # expect {"version":N}
curl -s -o /dev/null -w "%{http_code}\n" localhost:5183/built.drawdyx   # expect 200
```

The starter pins port 5183 with `strictPort`. Port 5173 belongs to another project on this machine.

## Point the board at another worktree's server

Dev links are stored per board in the browser. This board already has a link to `localhost:5183`. To switch worktrees, stop the server on 5183 and start the other one on 5183. Drawdy polls `/version` about once a second and reloads the driver when the version changes. You do not need to re-add the link.

Find the process holding the port with `lsof -iTCP:5183 -sTCP:LISTEN -n -P`, then stop it with `kill <pid>` or Ctrl-C in its terminal.

To add a link from scratch, or to use a second port:

- Press ⌘K and run **Add extension dev server**. Enter `http://localhost:5183` and press Connect.
- Press ⌘K and run **Remove extension dev server** to drop a link.
- The Extensions panel also lists links. Open its **Development** section to see each link and whether it is Connected.

Two dev servers that serve the same `driverId` install over each other. Run one server per board at a time.

## Switch tools

Press `K` or `Q` to select the laser pointer. Verified: after `K`, the Laser pointer button reports `aria-pressed="true"`. The other keys are `N` for sticky note and `F` for frame. ⌘K then **Keyboard Shortcuts** lists them all.

The toolbar sits at the top center. Its buttons have these aria labels: Select, Hand, Pencil, Eraser, Line, Arrow, Text, Sticky note, Rectangle, Circle, Diamond, Image, Laser pointer. Click Select to stop drawing.

A shape tool's style panel covers the top-left corner, about x 12 to 193 and y 82 to 534 px at 61% zoom. In this run, a press inside that area did not reach the canvas. Start drags to the right of the panel.

## Read the driver logs

The bug badge at the bottom right of the board opens **SDK events**. Its count matches the events it lists. Each entry shows a request, a response, or a subscription, with the command type and the driver id. The trash icon clears the list. Verified. Screenshot: `docs/qa/sdk-events-panel.png`.

The terminal running `npm run dev` prints `[drawdy] built vN (...)` on each save. This run logged to `.audit/dev-server.log`, which is gitignored.

The browser console was not checked. The starter never calls `console.log`, so DevTools on the board tab is the place to look if a driver error needs more detail.

## Accept permission prompts

The first command that needs a permission shows a prompt over the canvas. The starter triggers two.

| Permission | Prompt text | When it appears | Screenshot |
|---|---|---|---|
| `dom` | "wants to add to the interface" | On connect, from `activate` | `docs/qa/prompt-dom-allow.png` |
| `scene` | "wants to read 'Oct 17, 2026'" | On the first canvas write | `docs/qa/prompt-scene-allow.png` |

Click **Allow**. Do not press Escape, the X, or **Dismiss**. Those can save a Deny for this device and this driver. To undo a Deny, remove the driver and install it again.

In automation, click Allow in the same script run that triggered the prompt. The scene prompt disappeared between two script runs with no answer from anyone. Re-triggering brought it back, so as far as I can tell nothing was stored.

## Draw the test board

Coordinates are CSS pixels in a 1200 by 1289 viewport at 61% zoom. Press the minus button at (63, 1252) five times to reach that zoom.

1. Pencil. Click `button[aria-label="Pencil"]`, then drag with `mouse.move`, `mouse.down`, many `mouse.move` steps, and `mouse.up`. Use 60 or more points per shape. A six-point path smooths into a blob.
2. Rectangle, Line, and Arrow. Use the same drag pattern. Press Escape after each shape to deselect it.
3. Sticky note. Click the tool, then click the canvas. The note centers on the click. Wait, call `keyboard.insertText(text)`, then press Escape twice.

Board contents:

- Clouds at about (560, 230) and (950, 200).
- A noodle bowl with three steam curls at about (760, 440).
- A zigzag at y 400, from x 880 to 1080.
- A wave at y 470, from x 150 to 420.
- A tree at x 1040, from y 555 to 745, with grass at y 748.
- A teardrop leaf near (510, 555). It was meant to be a house. The six-point path smoothed into a leaf.
- The bar chart has four rectangles from x 170 to 395, bottoms at y 400, and a baseline from (150, 402) to (420, 402).
- Stickies: `ประชุมวันจันทร์` at (160, 560), `งบ Q3` at (330, 560), `Ship the beta` at (600, 735), and `Review Friday` at (830, 700).
- Three arrows run from the chart to the cloud, from Review Friday to the bowl, and from the zigzag to the tree.
- The starter note `Hello from my extension` at about (600, 643). It came from the starter's context-menu item, and I left it on the board.

Board screenshots: `board-final.png`, `arrows.png`, `doodles-pass1.png`, `bar-chart.png`, and `stickies.png`.

## Trigger the starter menu item

Right-click empty canvas. Hover **Extension**, then click **Add sticky note**. Per the starter source, the note is placed at canvas (160, 160), and the camera flies to it. Screenshots: `docs/qa/context-menu-extension.png` and `docs/qa/starter-note-after-allow.png`.

## What worked

- The dev server on 5183 answered `/version` and `/built.drawdyx`.
- A new local board came from the workspace list.
- The `localhost:5183` link connected from the command palette.
- The starter driver loaded, and both `dom` and `scene` were granted.
- The starter note appeared on the board.
- Reopening the exact board URL after the dev server stopped kept every element, including the stickies and arrows. That screenshot is in `.audit/board-reopened.png`, which is gitignored.
- Pencil, rectangle, line, arrow, and sticky note all drew with pointer drags. Thai text typed with `insertText` rendered correctly.

## What failed and how it was handled

1. The bare `drawdy.io/` reopened the other team's board, `YWasJVp4`. I opened its Menu and chose Go to workspace. I did not edit anything on it. Use the exact `?local=` URL every time.
2. After clicking Local in the New board dialog, the URL stayed at `drawdy.io/`. The new id came from the workspace list. Its anchors match `a[href*="local="]`, and the newest one sits at the top.
3. Screenshots failed with "Cannot capture a screenshot while the window is minimized". `Page.bringToFront` did not help. Setting the window to normal with `Browser.setWindowBounds` fixed it. That restores the window for the whole browser, so any other team tabs in it became visible. I did not touch those tabs.
4. The first scene prompt vanished before I answered it. See the permission section.
5. The first bar was missing. The Rectangle tool's style panel covered its start point. Dragging from right to left drew it. This is a workaround for the test board, not a fix. The product problem is that the panel covers the canvas at 61% zoom.
6. The house came out as a teardrop. The six-point path smoothed into a leaf. It is left on the board as a doodle.
7. `mouse.down` and `mouse.up` reject a `label` option. Only `click`, `move`, and `wheel` take one.

## Finding for the driver team

The starter's `activate` sends `command:context-menu:add`, a `dom` command, as soon as the dev server connects. The `dom` prompt therefore shows before any user action. `docs/FACTS.md` rule 3 says no `dom`, `scene`, `collaboration`, or `storage` command may run before the user clicks the action button. The starter predates that rule. The It's In There driver has to gate these commands.
