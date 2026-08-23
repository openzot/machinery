#!/usr/bin/env bash
# Validate the machinery catalogue: site/machines.json is well formed, every
# listed machine exists as the four-file set (index.html + machine.css +
# machine.js + manual.html) with no external requests, every control and every
# fault the catalogue names is on the panel and in the manual, and no two
# machines are the same machine in disguise - not by kind, not by era and
# domain, not by design, not by the way you operate it, and not by colour.
# Exit 0 when the site is publishable.
#
# This is the static half of the gate. scripts/probe.sh is the dynamic half:
# it opens the newest machine in a browser and drives it.
set -euo pipefail
cd "$(dirname "$0")/.."

python3 - <<'PY'
import json, os, re, sys

problems = []
def bad(msg): problems.append(msg)

try:
    with open("site/machines.json", encoding="utf-8") as f:
        machines = json.load(f)
except Exception as e:
    print(f"check: site/machines.json is not valid JSON: {e}")
    sys.exit(1)

if not isinstance(machines, list):
    print("check: site/machines.json must be a JSON array")
    sys.exit(1)

STRINGS = ["slug", "name", "kind", "domain", "era", "design", "interaction", "tagline", "created"]
LISTS = {"palette": 3, "controls": 4, "faults": 2}
REQUIRED_FILES = ["index.html", "machine.css", "machine.js", "manual.html"]
SIZE_LIMIT = 200 * 1024

# The two vocabularies that make "no two machines alike" mechanical rather
# than a matter of wording. A machine is placed in exactly one domain and one
# era, and no two machines may share the pair. AGENTS.md lists the same words.
DOMAINS = {
    "aerospace", "agriculture", "aviation", "broadcast", "chemical", "civic",
    "cold-chain", "data-centre", "deep-sea", "energy", "laboratory", "marine",
    "medical", "military", "mining", "nuclear", "oil-and-gas", "power-grid",
    "rail", "road", "space", "telecom", "theatre", "water", "weather",
}
ERAS = {"1920s", "1940s", "1950s", "1960s", "1970s", "1980s", "1990s", "2000s", "2020s", "speculative"}

# Headings the manual must carry, in this order, as <h2>. The manual is part
# of the machine: a panel nobody can learn to operate is a picture of a panel.
MANUAL_SECTIONS = ["overview", "controls", "normal operation", "alarms", "faults and recovery", "specifications"]

# Two machines may not be told apart by colour alone - so the chassis and
# accent colours of a new machine must together sit at least this far (sRGB
# distance, summed) from those of every machine already on the shelf.
PALETTE_DISTANCE = 80

external = re.compile(
    r"""(?:src|href|action|poster|data)\s*=\s*["']\s*(?:https?:)?//|url\(\s*["']?\s*(?:https?:)?//|@import\s+["']?\s*(?:https?:)?//|"""
    r"""\bfetch\(\s*["'`](?:https?:)?//|\bimport\(\s*["'`](?:https?:)?//|^\s*import\s.*from\s*["'`](?:https?:)?//|"""
    r"""new\s+(?:WebSocket|EventSource|XMLHttpRequest|Audio|Image|Worker)\s*\(\s*["'`](?:https?:)?//""",
    re.I | re.M,
)

def norm(s):
    return re.sub(r"\s+", " ", str(s).strip().lower())

def rgb(h):
    m = re.fullmatch(r"#([0-9a-f]{6})", h.strip().lower())
    if not m:
        return None
    v = int(m.group(1), 16)
    return ((v >> 16) & 255, (v >> 8) & 255, v & 255)

def dist(a, b):
    return sum((x - y) ** 2 for x, y in zip(a, b)) ** 0.5

def text_of(html):
    html = re.sub(r"<(script|style)\b.*?</\1>", " ", html, flags=re.I | re.S)
    html = re.sub(r"<[^>]+>", " ", html)
    html = re.sub(r"&nbsp;", " ", html)
    return norm(html)

slugs, names, kinds, designs, interactions, pairs, palettes = {}, {}, {}, {}, {}, {}, []

for i, g in enumerate(machines):
    where = f"entry {i}"
    if not isinstance(g, dict):
        bad(f"{where}: not an object"); continue
    for k in STRINGS:
        if not isinstance(g.get(k), str) or not g[k].strip():
            bad(f"{where}: missing or empty field '{k}'")
    for k, n in LISTS.items():
        v = g.get(k)
        if not isinstance(v, list) or len(v) < n or not all(isinstance(x, str) and x.strip() for x in v):
            bad(f"{where}: '{k}' must be a list of at least {n} non-empty strings")
    slug = g.get("slug", "") if isinstance(g.get("slug"), str) else ""
    where = f"entry {i} ({slug or '?'})"
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug):
        bad(f"{where}: slug must be lowercase a-z0-9 with single dashes")
    if slug in slugs:
        bad(f"{where}: duplicate slug (also entry {slugs[slug]})")
    slugs[slug] = i

    name = norm(g.get("name", ""))
    if name in names:
        bad(f"{where}: duplicate name (also entry {names[name]})")
    names[name] = i

    kind = norm(g.get("kind", ""))
    if kind in kinds:
        bad(f"{where}: same kind of machine as entry {kinds[kind]} ({kind!r})")
    kinds[kind] = i

    design = norm(g.get("design", ""))
    if len(design.split()) < 6:
        bad(f"{where}: 'design' must describe the design language in at least six words (material, legends, lighting, ...)")
    if design in designs:
        bad(f"{where}: same design as entry {designs[design]}")
    designs[design] = i

    interaction = norm(g.get("interaction", ""))
    if interaction in interactions:
        bad(f"{where}: same interaction as entry {interactions[interaction]}")
    interactions[interaction] = i

    domain, era = norm(g.get("domain", "")), norm(g.get("era", ""))
    if domain not in DOMAINS:
        bad(f"{where}: domain {domain!r} is not one of: {', '.join(sorted(DOMAINS))}")
    if era not in ERAS:
        bad(f"{where}: era {era!r} is not one of: {', '.join(sorted(ERAS))}")
    if (domain, era) in pairs:
        bad(f"{where}: same domain + era as entry {pairs[(domain, era)]} ({domain}, {era})")
    pairs[(domain, era)] = i

    pal = g.get("palette") if isinstance(g.get("palette"), list) else []
    cols = [rgb(c) for c in pal if isinstance(c, str)]
    if len(cols) < 3 or any(c is None for c in cols):
        bad(f"{where}: palette must be at least three #rrggbb colours: chassis, accent, alarm")
    else:
        if dist(cols[0], cols[1]) < 60:
            bad(f"{where}: chassis and accent colours are too close to read as a palette")
        for j, (c0, c1) in enumerate(palettes):
            d = dist(cols[0], c0) + dist(cols[1], c1)
            if d < PALETTE_DISTANCE:
                bad(f"{where}: chassis + accent colours are within {d:.0f} of entry {j}'s (need {PALETTE_DISTANCE}); pick a different colour story")
        palettes.append((cols[0], cols[1]))

    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", g.get("created", "") if isinstance(g.get("created"), str) else ""):
        bad(f"{where}: created must be YYYY-MM-DD")

    d = os.path.join("site", "machines", slug)
    page = os.path.join(d, "index.html")
    manual = os.path.join(d, "manual.html")
    if not os.path.isdir(d):
        bad(f"{where}: {d} does not exist"); continue

    missing = [n for n in REQUIRED_FILES if not os.path.isfile(os.path.join(d, n))]
    if missing:
        bad(f"{where}: {d} is missing {', '.join(missing)}"); continue
    extra = [n for n in os.listdir(d) if n not in REQUIRED_FILES]
    if extra:
        bad(f"{where}: extra files in {d}: {', '.join(sorted(extra))}"
            f" (a machine is exactly {', '.join(REQUIRED_FILES)})")

    total = sum(os.path.getsize(os.path.join(d, n)) for n in REQUIRED_FILES)
    if total > SIZE_LIMIT:
        bad(f"{where}: {d} is {total // 1024} KB in total; keep a machine under ~160 KB")

    sources = {}
    for n in REQUIRED_FILES:
        with open(os.path.join(d, n), encoding="utf-8", errors="replace") as f:
            sources[n] = f.read()
        m = external.search(sources[n])
        if m:
            bad(f"{where}: external request in {os.path.join(d, n)}: {m.group(0).strip()!r}")

    for n in ("index.html", "manual.html"):
        html = sources[n]
        p = os.path.join(d, n)
        if "<html" not in html.lower():
            bad(f"{where}: {p} does not look like an HTML document")
        if not re.search(r"""<link\b[^>]*\bhref\s*=\s*["']\.?/?machine\.css["']""", html, re.I):
            bad(f"{where}: {p} does not link the stylesheet (<link rel=\"stylesheet\" href=\"machine.css\">)")
        if re.search(r"<style\b[^>]*>(?!\s*</style>)", html, re.I):
            bad(f"{where}: {p} has an inline <style> block; all CSS belongs in machine.css")
        for m in re.finditer(r"<script\b([^>]*)>", html, re.I):
            if not re.search(r"""\bsrc\s*=""", m.group(1), re.I):
                bad(f"{where}: {p} has an inline <script> block; all JS belongs in machine.js")
                break
        if "../../" not in html:
            bad(f"{where}: {p} has no relative link back to the catalogue (../../)")

    html = sources["index.html"]
    if not re.search(r"""<script\b[^>]*\bsrc\s*=\s*["']\.?/?machine\.js["']""", html, re.I):
        bad(f"{where}: {page} does not load its script (<script src=\"machine.js\"></script>)")
    if not re.search(r"""<dialog\b[^>]*\bdata-manual\b""", html, re.I):
        bad(f"{where}: {page} has no <dialog data-manual> (the manual opens in the panel, not a new tab)")
    if not re.search(r"""<iframe\b[^>]*\bsrc\s*=\s*["']\.?/?manual\.html["']""", html, re.I):
        bad(f"{where}: {page} does not embed manual.html in an <iframe> inside the dialog")
    if not re.search(r"""\bdata-action\s*=\s*["']manual["']""", html, re.I):
        bad(f"{where}: {page} has no control with data-action=\"manual\" to open the manual")
    if not re.search(r"""\bdata-action\s*=\s*["']close-manual["']""", html, re.I):
        bad(f"{where}: {page} has no control with data-action=\"close-manual\"")

    # every control the catalogue names is a real element on the panel
    on_panel = {norm(m) for m in re.findall(r"""\bdata-control\s*=\s*["']([^"']+)["']""", html, re.I)}
    for c in (g.get("controls") or []):
        if isinstance(c, str) and norm(c) not in on_panel:
            bad(f"{where}: control {c!r} is in the catalogue but no element on the panel has data-control=\"{c}\"")

    # the manual: the fixed sections, in order, and every control and fault
    # the catalogue names is written up in it
    man = sources["manual.html"]
    heads = [norm(re.sub(r"<[^>]+>", "", h)) for h in re.findall(r"<h2\b[^>]*>(.*?)</h2>", man, re.I | re.S)]
    want = list(MANUAL_SECTIONS)
    for h in heads:
        if want and h.startswith(want[0]):
            want.pop(0)
    if want:
        bad(f"{where}: manual.html is missing <h2> section(s) in order: {', '.join(want)} "
            f"(required: {' / '.join(MANUAL_SECTIONS)})")
    if not re.search(r"""<ol\b""", man, re.I):
        bad(f"{where}: manual.html has no numbered procedure (<ol>) - Normal operation must be steps")
    body = text_of(man)
    for c in (g.get("controls") or []):
        if isinstance(c, str) and norm(c) not in body:
            bad(f"{where}: control {c!r} is not mentioned in manual.html")
    for fz in (g.get("faults") or []):
        if isinstance(fz, str) and norm(fz) not in body:
            bad(f"{where}: fault {fz!r} is not written up in manual.html")
    if not re.search(r"""\bhref\s*=\s*["'](?:\./|index\.html|\.)["']""", man, re.I):
        bad(f"{where}: manual.html has no link back to the panel (href=\"./\" or \"index.html\")")

    js = sources["machine.js"]
    if not re.search(r"window\.machine\s*=", js):
        bad(f"{where}: machine.js never assigns window.machine (the fixed API the probe drives)")
    if re.search(r"^\s*(import|export)\b", js, re.M):
        bad(f"{where}: machine.js is an ES module; it must be a classic script")

# machines on disk that the catalogue does not list are fine (a shift in
# progress), but say so
listed = set(slugs)
on_disk = {n for n in os.listdir("site/machines") if os.path.isdir(os.path.join("site/machines", n))} if os.path.isdir("site/machines") else set()
for s in sorted(on_disk - listed):
    print(f"check: note: site/machines/{s} is not in the catalogue yet")

if problems:
    for p in problems:
        print(f"check: {p}")
    print(f"check: {len(problems)} problem(s)")
    sys.exit(1)

print(f"check: ok - {len(machines)} machine(s) in the catalogue")
PY
