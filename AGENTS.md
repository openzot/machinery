# The machinery

This repository is a demonstration: a software factory that ships one working
machine every shift, unattended. You are the factory. Each run of
`orders/new-machine.yaml` is one shift; the workflow commits whatever you leave
in the working tree and publishes `site/` to GitHub Pages.

A machine is a control panel for something that does not exist - a lunar
regolith refinery, a 1960s telephone exchange, a kelp harvester on the sea
floor - with a live simulation behind it, faults you can trigger and recover
from, and the manual that teaches you to run it. The panel is the product. It
is judged by looking at it, and you will look at it before you are done.

## Layout

```
site/
  index.html            the catalogue page (reads machines.json; do not edit)
  machines.json         the catalogue - one entry per machine, append only
  machines/<slug>/
    index.html          the panel: structure only - links machine.css, loads machine.js
    machine.css         every rule the panel and the manual need
    machine.js          every line of behaviour; exposes window.machine
    manual.html         the operating manual, in the machine's own design
scripts/check.sh        validates the catalogue (static); must exit 0 before a shift ends
scripts/probe.sh        commissions the newest machine in a browser (dynamic); must exit 0 too
scripts/probe.js        what probe.sh runs; also takes the screenshots you look at
orders/new-machine.yaml the standing order you are running
```

## What is on the machine

No need to go looking: the shift installs the toolbox before you start.

- `node` v22 and `python3`. There is no `package.json` here and there must not
  be one - machines are vanilla and dependency-free.
- **Playwright with headless Chromium.** `require('playwright')` resolves from
  any directory. `scripts/probe.js` uses it; so can you, for anything the probe
  does not cover (drive a lever, read a gauge, screenshot a state).
- **The `view` tool.** You can look at images. The probe writes PNGs to
  `/tmp/machinery/`; view them. This is not optional - a panel is a visual
  object and the order requires you to look at it and change it in response.
- `prettier --check index.html machine.css machine.js manual.html`,
  `htmlhint index.html manual.html`, `quick-lint-js machine.js`,
  `node --check machine.js`. Point the linter straight at the file.

Scratch files - briefs, test scripts, screenshots, notes - go in `/tmp`. A
fifth file in the machine directory fails the check. The workflow commits
whatever is left in the working tree.

## Before you design: look at the shelf

1. Read `site/machines.json`.
2. For the three most recent entries, run
   `node scripts/probe.js <slug> --shots-only` and **view**
   `/tmp/machinery/<slug>-desktop.png`. You now know what the shelf looks like.
3. List ten candidates across different domains, eras and design languages.
   Strike anything that resembles an existing entry in kind, domain + era,
   design, interaction or colour. Build the one that is most unlike the rest.

## The design brief

Write it to `/tmp/brief.md` before any markup. It decides, in one line each:

| Decide | Examples |
| --- | --- |
| **The machine** | what it is, what it does, what goes wrong with it |
| **The place and the era** | a Baltic icebreaker's engine room, 1971; a Martian water plant, 2080 |
| **Who built the panel** | a shipyard, a state railway, a start-up, a monastery - it shows |
| **Chassis material** | hammer-finish grey enamel, brushed aluminium, bakelite, teak and brass, painted steel, moulded polymer, CRT glass |
| **Legends** | engraved and paint-filled, screen-printed, Dymo tape, stencilled, backlit film, etched |
| **Lighting model** | incandescent jewel lamps, neon, nixie, LED bars, CRT phosphor, vacuum-fluorescent, e-ink, reflective paint under room light |
| **Typography** | which system faces and how: condensed caps for legends, a narrow mono for readouts, a serif for the manual - and the letter-spacing, weight and case that make it period |
| **Palette** | chassis, accent, alarm - three hex colours, plus what else the machine needs; no two machines on the shelf share a colour story |
| **The signature control** | the one thing you operate that no other machine has: a patch bay, a pull chain, a dead-man handle, a chart recorder, a slide rule, a telegraph |
| **The layout logic** | why the controls sit where they sit - process flow left to right, a mimic diagram in the middle, start-up sequence top to bottom |
| **Sound** | none, or what: relays, a hum, a klaxon - after a gesture only |

Then build the panel that brief describes, and nothing else.

## Slop tells

These are rejected at review, which is to say: by you, when you look at the
screenshot. If you see one, fix it before you move on.

- A **dashboard**: a grid of rounded cards with a number in each. That is a
  web page about a machine, not a machine.
- **Glow-on-dark by default.** Dark chassis with neon-blue edges is one era's
  look (and the arcade's), not every machine's. A 1950s panel is grey enamel in
  daylight; a 2020s skid is white powder-coat with a touchscreen.
- **Emoji**, stock icon fonts, clip-art, or gradients that do not describe a
  material.
- **Rounded-everything** and `box-shadow: 0 0 20px` on everything. Real panels
  have edges, bezels, countersunk screws, hinges, label plates.
- **Generic controls**: a row of identical `<button>`s, or `<input type=range>`
  unstyled. Draw the knob. Draw the lever travel. Guard the switch.
- **Same font as last time.** If the last three machines used a monospace
  readout on a dark ground, yours does not.
- **Gauges that do nothing**, lamps that never light, alarms without a
  consequence. Every indicator is driven by `machine.js`.
- **A manual that is a paragraph.** The manual is a document: sections,
  numbered procedures, a specifications table, in the machine's type.

## The catalogue entry

Append exactly one object to the array in `site/machines.json`:

```json
{
  "slug": "kestrel-tug",
  "name": "Kestrel Orbital Tug - RCS & Docking Console",
  "kind": "orbital tug reaction-control and docking console",
  "domain": "space",
  "era": "1970s",
  "design": "olive-drab enamel chassis, engraved white legends, guarded toggles, incandescent jewel annunciators, a mechanical range drum",
  "interaction": "guarded toggles flipped in a fixed arming sequence and a two-axis thumb nudger for the approach",
  "palette": ["#3b4a3e", "#f3e3b4", "#d2402a"],
  "controls": ["MASTER ARM", "RCS MODE", "RANGE DRUM", "THRUST NUDGER", "DOCK LATCH"],
  "faults": ["thruster stuck open", "range sensor dropout"],
  "tagline": "Bring her in at two metres a second, not three.",
  "created": "2026-08-23"
}
```

- `slug` is lowercase `a-z0-9-`, unique, and is the directory name.
- `kind` is what the machine is, in a few words; no two machines share one.
- `domain` is one of: `aerospace`, `agriculture`, `aviation`, `broadcast`,
  `chemical`, `civic`, `cold-chain`, `data-centre`, `deep-sea`, `energy`,
  `laboratory`, `marine`, `medical`, `military`, `mining`, `nuclear`,
  `oil-and-gas`, `power-grid`, `rail`, `road`, `space`, `telecom`, `theatre`,
  `water`, `weather`.
- `era` is one of: `1920s`, `1940s`, `1950s`, `1960s`, `1970s`, `1980s`,
  `1990s`, `2000s`, `2020s`, `speculative`. **No two machines share a
  domain + era pair.**
- `design` is the design language in at least six words - material, legends,
  lighting, the rest of the brief. Unique.
- `interaction` is how you operate it - the signature control and the idiom.
  Unique.
- `palette` is `[chassis, accent, alarm, ...]` as `#rrggbb`. Chassis + accent
  together must sit at least 80 (sRGB distance, summed) from every other
  machine's. The check tells you if they do not.
- `controls` are the names on the panel, each carried by an element with
  `data-control="<name>"` and each written up in the manual. At least four, of
  at least three different kinds.
- `faults` are the names in `window.machine.faults`, each triggerable from the
  panel, each with a recovery procedure in the manual. At least two.
- `created` is today's date in UTC (`date -u +%F`).

Keep the JSON valid - trailing commas break the site.

## Four files, always

| File | Holds | Must not hold |
| --- | --- | --- |
| `index.html` | the panel: `<head>` metadata, the chassis, controls, indicators, the manual `<dialog>` | any `<style>` block, any inline `<script>` block |
| `machine.css` | every rule - the panel and the manual | - |
| `machine.js` | every line of behaviour, wrapped in an IIFE, assigning `window.machine` | `import`/`export` |
| `manual.html` | the operating manual, linking `machine.css` | any `<style>` or `<script>` |

```html
<link rel="stylesheet" href="machine.css">   <!-- in <head>, both pages -->
<script src="machine.js"></script>           <!-- last thing in <body>, panel only -->
```

Write them in that order: markup, then style, then behaviour, then the manual.
`scripts/check.sh` enforces the split, so a one-file machine does not ship.

## The fixed API

`machine.js` assigns, from inside its IIFE:

```js
window.machine = {
  name: "Kestrel Orbital Tug",
  faults: ["thruster stuck open", "range sensor dropout"],
  state()        // -> plain object; must include alarms: [names of active alarms]
  tick(seconds)  // advance the simulation by that many seconds; deterministic
  inject(fault)  // trigger one of `faults`
  reset()        // back to cold and alarm-free
};
```

The animation loop calls the same `tick()` with real elapsed time; the probe
calls it with whole seconds. `state()` is what the probe reads, so put the
quantities that matter in it - they must stay finite numbers for ten simulated
minutes of running. `reset()` must clear every alarm and every fault.

## The manual

`manual.html` opens from the panel - `[data-action="manual"]` opens
`<dialog data-manual>` which contains `<iframe src="manual.html">`, and
`[data-action="close-manual"]` closes it - and also works on its own. It is
written in the machine's own design (it links `machine.css`), links back to
the panel (`href="./"`) and to the catalogue (`../../`), and has these `<h2>`
sections in this order:

1. **Overview** - what the machine is and does, in the voice of whoever built it
2. **Controls** - every control on the panel, what it does, its positions
3. **Normal operation** - a numbered `<ol>` procedure from cold to running
4. **Alarms** - every lamp and annunciator, what it means, what to do
5. **Faults and recovery** - every fault, what you see, how to clear it
6. **Specifications** - a table: ratings, ranges, limits

The manual is the document that would be bolted to the cabinet. Write it that
way.

## Commissioning

```
scripts/probe.sh <slug>
```

opens the panel in headless Chromium and checks the API, the controls, the
manual, every fault, the reset, ten minutes of running, and the layout at
1440px and 390px; it writes `/tmp/machinery/<slug>-desktop.png`, `-phone.png`
and `-manual.png`. **View them.** Ask: does this look like the brief? Like a
panel from that place and era? Like nothing else on the shelf? Would I stand in
front of it? Fix what fails the question, run the probe again, look again. The
order requires at least one change made because of what you saw.

## Conventions

- Vanilla HTML/CSS/JS split across the four files; no network requests; art
  drawn in code or embedded as data URIs; sound via Web Audio, after a gesture.
- Title and the manual control visible on screen; reset without reload; a
  relative link back to the catalogue (`../../`).
- `requestAnimationFrame` loop feeding `tick()`; pause when the tab is hidden.
- Desktop first - a panel is wide - but nothing overflows at 390px and the
  manual is reachable there.
- Keyboard: every control reachable and operable with Tab and Enter/Space or
  arrows; `aria-label` where the legend is drawn rather than written.
- Do not touch other machines, the catalogue page, the scripts, the order or
  the workflow. Do not run git commands that change history or the remote.
