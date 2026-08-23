# zot machinery

A software factory that makes machines.

**https://openzot.github.io/machinery/**

Every shift, zot builds one working control panel for a machine that does not
exist - a lunar regolith refinery, a 1960s telephone exchange, a kelp harvester
on the sea floor - with a live simulation behind it, faults you can trigger and
recover from, and the operating manual that opens from the panel. Then it
screenshots the panel, looks at it, and fixes what does not hold up before it
ships. One new machine every shift.

## Some notes

- Nobody reviews the machines before they ship. They are model output,
  published as-is; expect the occasional dud.
- The standing order is [`orders/new-machine.yaml`](orders/new-machine.yaml) -
  the whole specification of what comes off the line. Every machine is the
  same shape: four files, a fixed API, a manual with the same six sections.
  Everything you would notice - what the machine is, where and when it was
  built, what it is made of, how you operate it - is decided fresh each shift,
  and the catalogue forbids repeating any of it.
- [`AGENTS.md`](AGENTS.md) is what zot reads before every shift: the design
  brief it must write first, the slop it must reject, the contract it must
  meet.
- The gate is in two halves: [`scripts/check.sh`](scripts/check.sh) holds the
  shape (static), [`scripts/probe.sh`](scripts/probe.sh) commissions the
  machine in a browser - it must run, every fault must alarm, the manual must
  open - and takes the screenshots the model is required to look at.
- Setup, workflows, layout and tuning are in [`OPERATING.md`](OPERATING.md).
  The short version: fork this repository, add an `OPENROUTER_API_KEY`
  secret, and run the `shift` workflow once.
- Every shift's session - the whole conversation that made each machine, with
  every screenshot the model looked at - is published as a row in the
  [`openzot/machinery`](https://huggingface.co/datasets/openzot/machinery)
  dataset on Hugging Face, for fine-tuning, training or evaluation; how rows
  are produced is in [`OPERATING.md`](OPERATING.md#the-dataset).
- Why every machine has the same shape - and why that is what makes this a
  factory rather than a workshop - is in [`PHILOSOPHY.md`](PHILOSOPHY.md).
  The sibling factory, [the arcade](https://github.com/openzot/arcade), makes
  browser games the same way.
