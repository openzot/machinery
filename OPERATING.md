# Operating the machinery

How this repository is wired: setup, the workflows, the layout, and what to
turn when you want it to behave differently. The factory itself - what it
makes and why the output shape is fixed - is in [README.md](README.md) and
[PHILOSOPHY.md](PHILOSOPHY.md).

The model doing the work is `stealth/ox-alpha` via
[OpenRouter](https://openrouter.ai), through
[openzot/actions](https://github.com/openzot/actions). It has to be a model
that can see: the shift depends on the `view` tool.

## Run your own

1. Create a repository from this one (fork, or push a copy) - it must be
   public for free GitHub Pages, and Actions must be enabled.
2. Add one repository secret: **`OPENROUTER_API_KEY`**. Without it a shift
   idles (it says so in the run summary) rather than failing every half hour.
3. Run the `shift` workflow once from the Actions tab (or wait for the next
   half hour). The first run enables GitHub Pages for the repository; if your
   token is not allowed to, enable it once by hand: *Settings → Pages →
   Source: GitHub Actions*.

That is the whole setup. The site appears at
`https://<owner>.github.io/<repo>/`.

Optionally, add an **`HF_TOKEN`** secret (a Hugging Face token with write
access) and every shift also ships its conversation to a dataset - see
[The dataset](#the-dataset).

## How a shift works

```
shift  cron */30 ──▶ checkout ──▶ zot orders/new-machine.yaml ──▶ check.sh ──▶ probe.sh ──▶ git commit + push ──▶ dispatch pages
                                    (openzot/actions/run)        static      browser      always, to main

pages  push to site/ ──▶ scripts/check.sh ──▶ deploy site/
       (or dispatch)      catalogue valid?    only if valid
```

- **The order never changes; the catalogue does.** `site/machines.json` is
  the factory's memory. The order tells zot to read it first, look at the three
  most recent machines (the probe screenshots them), list ten candidate
  machines spanning different domains, eras and design languages, discard
  anything resembling an existing entry, and build the most different one.
  Uniqueness is checked on `kind`, on `domain + era`, on `design`, on
  `interaction`, on the name, and on the chassis + accent colours.
- **One shift, one commit - via a branch.** The shift never works on `main`:
  it opens `shift/<run-id>` first and pushes a snapshot of the working tree to
  it every five minutes while the model works, so a runner that dies - job
  timeout, cancellation, infrastructure - loses at most five minutes. At the
  end the branch is squash-merged onto `main` as one commit - `shift:
  <Machine> - <tagline>` when the order settled, `shift: work in progress`
  when it was cut short - and deleted; the snapshots never reach `main`'s
  history. If the merge will not land, the branch simply stays: it is the
  rescue. The next shift starts by folding any stranded `shift/*` branch back
  into its working tree, so stranded work is finished rather than lost - only
  a branch that no longer merges cleanly is left for a human, loudly. A
  machine only appears on the site once it is in `machines.json`, which the
  order says to do last, so an unfinished machine is invisible until a later
  shift finishes it.
- **Shifts do not overlap.** A concurrency group makes a due shift wait for the
  running one. A shift that hits the 50-minute step timeout is committed as is,
  and because session logs are kept in the Actions cache, the next shift
  *continues that conversation* rather than starting a new machine.
- **Every machine has the same shape.** A machine is exactly `index.html` +
  `machine.css` + `machine.js` + `manual.html`, nothing else in the directory,
  no inline `<style>` or `<script>`; `machine.js` exposes the fixed
  `window.machine` API; the manual has the same six sections in the same
  order. Splitting the files makes each shift faster and lets each file go to
  the linter that understands it.
- **The gate is in two halves.** `scripts/check.sh` is static: the JSON, the
  four files, no external requests, every control on the panel and in the
  manual, every fault in the manual, the manual's sections, and the
  no-repetition rules. `scripts/probe.sh` is dynamic: it opens the newest
  machine in headless Chromium and checks that it runs without errors, that
  the API is there, that every control is visible, that the manual opens and
  closes from the panel, that every fault raises an alarm and `reset()` clears
  it, that ten simulated minutes leave every number finite, and that nothing
  overflows at 1440px or 390px. It writes the screenshots the order requires
  the model to look at. The order says to run it; the workflow runs it again
  and the shift is red if it fails.
- **Publishing is not the shift's job.** `pages.yaml` deploys `site/` whenever
  anything lands on `main` under it - a shift's commit, a hand edit, a subtree
  push. The shift only makes the machine and commits it, then dispatches the
  deploy.
- **Only a valid catalogue is published.** `pages.yaml` runs `check.sh` before
  every deploy and stops there if it fails, so a broken catalogue is still
  committed (the history is honest) but the live site keeps serving the last
  good tree, and the order tells the next shift to repair it.

## The dataset

The machine is the product; the conversation that made it is the more
interesting record - and for this factory the conversation includes every
screenshot the model looked at and what it decided to change. With an
`HF_TOKEN` secret, the end of every shift runs `scripts/ship.py`, which:

1. exports the shift's session with `zot sessions export` - the conversation in
   the chat shape training and evaluation tooling reads (`system` / `user` /
   `assistant` with `tool_calls` / `tool`), the images the model was shown
   beside it, and the run's outcome and timings on top;
2. attaches the machinery's side - the catalogue entry, the four files, the
   commit, whether `check.sh` and `probe.sh` passed;
3. refuses to upload if the provider key appears anywhere in it;
4. appends it to the dataset as `trajectories/<session-id>/`.

The dataset repo is `openzot/machinery` unless a repository secret
**`HF_DATASET`** names another; it is created on first upload, and its card
(the `README.md` describing the rows) lives in the dataset repo itself, not
here. Every shift ships, finished or not: a shift cut short is a row, and the
shift that continues it ships the whole chain under its own id - the card says
how to filter. Without `HF_TOKEN` the step says so and does nothing.

## Layout

| Path | |
| --- | --- |
| `orders/new-machine.yaml` | the standing order |
| `AGENTS.md` | the design discipline and contract zot reads before every shift |
| `site/index.html` | the catalogue page (renders `machines.json`, with live previews) |
| `site/machines.json` | the catalogue - append only |
| `site/machines/<slug>/index.html` | one machine: the panel, structure only |
| `site/machines/<slug>/machine.css` | one machine: style (panel and manual) |
| `site/machines/<slug>/machine.js` | one machine: behaviour and the fixed API |
| `site/machines/<slug>/manual.html` | one machine: the operating manual |
| `scripts/check.sh` | catalogue validation (static) |
| `scripts/probe.sh`, `scripts/probe.js` | commissioning in a browser (dynamic) + screenshots |
| `scripts/ship.py` | ships a shift's session to the dataset |
| `.github/workflows/shift.yaml` | the shift - makes a machine, commits it |
| `.github/workflows/pages.yaml` | publishes `site/` to GitHub Pages |

## Tuning

- **Cadence**: the `cron` in the workflow. Each shift costs one zot run of up
  to `max-iterations` rounds against the model you configure.
- **Model**: `provider` / `model` in the workflow; any OpenAI-compatible
  provider zot supports works, with its key as the secret - but it must be a
  model that can see, and the `config` block in the workflow must tell zot so
  (`vision: true`) if zot's catalogue does not already know it.
- **Ambition**: the order's acceptance criteria. Raise them and shifts get
  longer and the machines bigger.
- **Output shape**: the acceptance criteria again, but the structural ones -
  the four-file split, the fixed API, the manual's sections, the size ceiling,
  the no-network rule. Change these and you have changed what the factory
  makes; `scripts/check.sh` and `scripts/probe.js` have to agree, or nothing
  publishes.
- **Distinctness**: the vocabularies (`DOMAINS`, `ERAS`) and the palette
  distance in `scripts/check.sh`, mirrored in `AGENTS.md`. Twenty-five domains
  by ten eras is 250 machines before the shelf is full; widen the lists when
  it is.

## Safety

zot runs with shell access in the checkout, on a GitHub-hosted runner, with
only the provider key in its environment (zot scrubs it from the agent's shell).
The job's `GITHUB_TOKEN` is scoped to this repository. The order forbids
touching the workflow, the scripts or existing machines; `scripts/check.sh`
and the commit history are how you would notice if it did.

What ships to the dataset is the whole conversation - every tool call and its
output, every screenshot - from a checkout of a public repository.
`scripts/ship.py` refuses the upload if the provider key turns up in it;
nothing else in the job's environment reaches the agent's shell.
