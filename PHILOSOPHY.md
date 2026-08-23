# Why the shape is fixed

A factory is organised around repetition. An injection-moulding line can
switch between several sunglasses frames, but the frame being made is decided
before production starts - its tolerances and its production path are known.
The contents change all the time. The shape doesn't. A sunglasses factory does
not make kitchen sinks.

The machinery works the same way. Every run ends with the same kind of
artefact: four files - a panel, its stylesheet, its behaviour, its manual - one
fixed API the probe can drive, a manual with the same six sections in the same
order, and one new row in the catalogue. That shape was decided up front, and
`scripts/check.sh` and `scripts/probe.sh` hold the line on it. The order never
changes either - the only thing that carries from one run to the next is the
catalogue, which the order says to read first, so each new machine has to
steer around every machine that came before it.

Everything a visitor would actually notice - what the machine is, where and
when it was built, what it is made of, how its legends are lettered, what lights
it, how you operate it, what goes wrong with it - is up for grabs. More than
that: it is *forbidden to repeat*. The catalogue will not take two machines of
the same kind, two from the same domain in the same decade, two with the same
design language, two operated the same way, or two that share a colour story.
The shape is fixed so that everything else can be forced to vary.

## Why look

The arcade's games are judged by playing them. A panel is judged by looking at
it: a control room reads at a glance as a real place or as a web page about
one, and the difference is visual - material, lettering, light, the way the
controls sit. So the order requires the model to write a design brief before
any markup, to screenshot the panel when it is built, to look at the
screenshot with its own eyes, and to change the design at least once because
of what it saw. The probe takes the pictures; the model has to look at them.
It also has to look at the last three machines on the shelf before it starts,
so "unlike everything already there" is a judgement made with eyes, not only a
rule checked on strings.

## Why a manual

A panel you cannot learn to operate is a picture of a panel. The manual is
part of the machine - it opens from the panel, it is written in the machine's
own design, and the check will not pass a manual that skips a section, leaves
out a control, or does not say how to clear a fault. It is also the thing that
makes the simulation honest: the Normal operation procedure has to work when
followed, and the Faults and recovery procedures have to actually clear the
alarms, or the probe says so.

That's the whole idea. Fix the shape so the process repeats; a process that
repeats is one you can improve; and make the model look at what it made, so
that "good" is something it sees rather than something it asserts.
