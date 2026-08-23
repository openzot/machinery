#!/usr/bin/env node
/**
 * Commission a machine: open it in headless Chromium and make sure it works.
 *
 *   node scripts/probe.js <slug> [--out DIR] [--shots-only]
 *
 * scripts/check.sh says the catalogue is well formed; this says the machine
 * actually runs. It loads site/machines/<slug>/index.html from disk and checks:
 *
 *   - no uncaught exceptions, console errors, failed or external requests;
 *   - the fixed API is there: window.machine with name, faults, state(),
 *     tick(seconds), inject(fault), reset();
 *   - every control the catalogue names is on the panel (data-control) and
 *     visible on a desktop screen;
 *   - the manual opens in the panel (data-action="manual" opens
 *     <dialog data-manual> with manual.html in an iframe) and closes again;
 *   - after reset() the machine is alarm-free; every catalogue fault, once
 *     injected, raises an alarm within sixty simulated seconds; reset() clears
 *     it; ten simulated minutes of running leaves every number finite;
 *   - nothing overflows sideways at 1440px or at 390px, and the manual is
 *     reachable on a phone;
 *   - manual.html also opens on its own without errors.
 *
 * It writes screenshots next to its verdict - the panel at desktop and phone
 * size, and with the manual open - so the model can look at what it built
 * (that is the point: a machine is judged by looking at it). Exit 0 when the
 * machine is sound.
 *
 * --shots-only skips every assertion and just takes the screenshots; the
 * order uses it to look at the machines already on the shelf before
 * designing a new one.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  args.splice(i, v && !v.startsWith("--") ? 2 : 1);
  return v && !v.startsWith("--") ? v : true;
};
const outDir = flag("--out") || "/tmp/machinery";
const shotsOnly = !!flag("--shots-only");
const slug = args[0];

if (!slug) {
  console.error("usage: node scripts/probe.js <slug> [--out DIR] [--shots-only]");
  process.exit(2);
}

const dir = path.join(ROOT, "site", "machines", slug);
const pageUrl = "file://" + path.join(dir, "index.html");
const manualUrl = "file://" + path.join(dir, "manual.html");

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const problems = [];
const bad = (m) => problems.push(m);
const say = (m) => console.log(`probe: ${m}`);

let entry = null;
try {
  const cat = JSON.parse(fs.readFileSync(path.join(ROOT, "site/machines.json"), "utf8"));
  entry = cat.find((m) => m && m.slug === slug) || null;
} catch (e) {
  if (!shotsOnly) bad(`site/machines.json could not be read: ${e.message}`);
}
if (!entry && !shotsOnly) say(`note: ${slug} is not in the catalogue yet; catalogue-linked checks are skipped`);
if (!fs.existsSync(path.join(dir, "index.html"))) {
  console.error(`probe: ${dir}/index.html does not exist`);
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (e) {
  console.error("probe: playwright is not installed (npm install -g playwright && playwright install chromium)");
  process.exit(2);
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();

  const errors = [];
  const external = [];
  page.on("pageerror", (e) => errors.push(`uncaught: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  page.on("requestfailed", (r) => errors.push(`request failed: ${r.url()}`));
  page.on("request", (r) => { if (!r.url().startsWith("file://") && !r.url().startsWith("data:") && !r.url().startsWith("blob:")) external.push(r.url()); });

  const shots = {};
  const shot = async (name) => {
    const file = path.join(outDir, `${slug}-${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    shots[name] = file;
  };

  await page.goto(pageUrl, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  await shot("desktop");

  // ---- the fixed API ------------------------------------------------------
  const api = await page.evaluate(() => {
    const m = window.machine;
    const out = { present: !!m && typeof m === "object", missing: [], name: null, faults: null };
    if (!out.present) return out;
    for (const k of ["state", "tick", "inject", "reset"]) if (typeof m[k] !== "function") out.missing.push(k + "()");
    if (typeof m.name !== "string" || !m.name.trim()) out.missing.push("name");
    if (!Array.isArray(m.faults) || !m.faults.length) out.missing.push("faults[]");
    out.name = m.name; out.faults = Array.isArray(m.faults) ? m.faults.slice() : null;
    return out;
  });
  if (!shotsOnly) {
    if (!api.present) bad("window.machine is not defined; machine.js must expose the fixed API");
    else if (api.missing.length) bad(`window.machine is missing ${api.missing.join(", ")}`);
    if (entry && api.faults) {
      const a = new Set(api.faults.map(norm)), b = new Set((entry.faults || []).map(norm));
      for (const f of b) if (!a.has(f)) bad(`catalogue fault ${JSON.stringify(f)} is not in window.machine.faults`);
      for (const f of a) if (!b.has(f)) bad(`window.machine.faults has ${JSON.stringify(f)} which the catalogue does not list`);
    }
  }

  // ---- controls on the panel --------------------------------------------
  if (!shotsOnly && entry) {
    const found = await page.evaluate((wanted) => {
      const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
      const els = Array.from(document.querySelectorAll("[data-control]"));
      return wanted.map((w) => {
        const el = els.find((e) => norm(e.getAttribute("data-control")) === norm(w));
        if (!el) return { w, present: false };
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const visible = r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
        return { w, present: true, visible };
      });
    }, entry.controls || []);
    for (const f of found) {
      if (!f.present) bad(`control ${JSON.stringify(f.w)}: no element with data-control on the panel`);
      else if (!f.visible) bad(`control ${JSON.stringify(f.w)}: on the panel but not visible at 1440x900 (hidden, zero-size or off screen)`);
    }
  }

  // ---- the manual opens in the panel ------------------------------------
  const manual = await page.evaluate(() => {
    const d = document.querySelector("dialog[data-manual]");
    const i = d && d.querySelector('iframe[src$="manual.html"]');
    const open = Array.from(document.querySelectorAll('[data-action="manual"]'));
    const close = Array.from(document.querySelectorAll('[data-action="close-manual"]'));
    return { dialog: !!d, iframe: !!i, openers: open.length, closers: close.length, initiallyOpen: !!(d && d.open) };
  });
  if (!shotsOnly) {
    if (!manual.dialog) bad("no <dialog data-manual> on the panel");
    if (!manual.iframe) bad('the manual dialog has no <iframe src="manual.html">');
    if (!manual.openers) bad('no [data-action="manual"] control to open the manual');
    if (!manual.closers) bad('no [data-action="close-manual"] control');
    if (manual.initiallyOpen) bad("the manual is open on load; it should open on request");
  }
  if (manual.dialog && manual.openers) {
    try {
      await page.locator('[data-action="manual"]').first().click({ timeout: 3000 });
      await page.waitForTimeout(500);
      const isOpen = await page.evaluate(() => !!document.querySelector("dialog[data-manual]")?.open);
      if (!isOpen && !shotsOnly) bad('clicking [data-action="manual"] did not open <dialog data-manual>');
      if (isOpen) await shot("manual");
      if (manual.closers) {
        await page.locator('[data-action="close-manual"]').first().click({ timeout: 3000, force: true });
        await page.waitForTimeout(300);
        const still = await page.evaluate(() => !!document.querySelector("dialog[data-manual]")?.open);
        if (still && !shotsOnly) bad('clicking [data-action="close-manual"] did not close the manual');
      }
    } catch (e) {
      if (!shotsOnly) bad(`operating the manual controls failed: ${e.message.split("\n")[0]}`);
    }
  }

  // ---- the machine runs, faults alarm, reset clears -----------------------
  if (!shotsOnly && api.present && !api.missing.length) {
    const run = await page.evaluate(() => {
      const m = window.machine;
      const out = [];
      const alarms = () => { const s = m.state(); return Array.isArray(s && s.alarms) ? s.alarms.map(String) : null; };
      const finite = (v, p = "state", acc = []) => {
        if (typeof v === "number") { if (!Number.isFinite(v)) acc.push(p); }
        else if (Array.isArray(v)) v.forEach((x, i) => finite(x, `${p}[${i}]`, acc));
        else if (v && typeof v === "object") for (const k of Object.keys(v)) finite(v[k], `${p}.${k}`, acc);
        return acc;
      };
      try {
        m.reset(); m.tick(5);
        const a0 = alarms();
        if (a0 === null) out.push("state().alarms is not an array");
        else if (a0.length) out.push(`alarms active right after reset(): ${a0.join(", ")}`);
      } catch (e) { out.push(`reset()/tick()/state() threw: ${e.message}`); return out; }
      for (const f of m.faults) {
        try {
          m.reset(); m.tick(5); m.inject(f);
          let raised = false;
          for (let t = 0; t < 60 && !raised; t++) { m.tick(1); const a = alarms(); if (a && a.length) raised = true; }
          if (!raised) out.push(`fault ${JSON.stringify(f)} raised no alarm within 60 simulated seconds`);
          m.reset(); m.tick(5);
          const a = alarms();
          if (a && a.length) out.push(`after fault ${JSON.stringify(f)}, reset() left alarms active: ${a.join(", ")}`);
        } catch (e) { out.push(`fault ${JSON.stringify(f)}: ${e.message}`); }
      }
      try {
        m.reset();
        for (let t = 0; t < 600; t++) m.tick(1);
        const nf = finite(m.state());
        if (nf.length) out.push(`after ten simulated minutes these are not finite numbers: ${nf.slice(0, 5).join(", ")}`);
      } catch (e) { out.push(`ten simulated minutes of tick() threw: ${e.message}`); }
      try { m.reset(); } catch (e) {}
      return out;
    });
    run.forEach(bad);
  }

  // ---- layout: desktop and phone -----------------------------------------
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (!shotsOnly && wide > 1) bad(`the panel overflows sideways by ${wide}px at 1440px`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  await shot("phone");
  const phone = await page.evaluate(() => {
    const wide = document.documentElement.scrollWidth - window.innerWidth;
    const o = document.querySelector('[data-action="manual"]');
    let manualVisible = false;
    if (o) { const r = o.getBoundingClientRect(); const cs = getComputedStyle(o); manualVisible = r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; }
    return { wide, manualVisible };
  });
  if (!shotsOnly) {
    if (phone.wide > 1) bad(`the panel overflows sideways by ${phone.wide}px at 390px (a phone)`);
    if (!phone.manualVisible) bad("the manual control is not visible at 390px; the manual must be reachable on a phone");
  }

  // ---- the manual on its own ----------------------------------------------
  const mpage = await context.newPage();
  const merrors = [];
  mpage.on("pageerror", (e) => merrors.push(`uncaught: ${e.message}`));
  mpage.on("console", (m) => { if (m.type() === "error") merrors.push(`console.error: ${m.text()}`); });
  mpage.on("requestfailed", (r) => merrors.push(`request failed: ${r.url()}`));
  try {
    await mpage.goto(manualUrl, { waitUntil: "load" });
    await mpage.waitForTimeout(500);
  } catch (e) {
    if (!shotsOnly) bad(`manual.html did not load: ${e.message.split("\n")[0]}`);
  }
  if (!shotsOnly) merrors.forEach((e) => bad(`manual.html: ${e}`));

  await browser.close();

  if (!shotsOnly) {
    errors.forEach((e) => bad(e));
    external.forEach((u) => bad(`external request: ${u}`));
  }

  for (const [k, v] of Object.entries(shots)) say(`screenshot ${k}: ${v}`);
  if (shotsOnly) { say(`${slug}: screenshots only`); return; }
  if (problems.length) {
    for (const p of problems) console.log(`probe: ${p}`);
    console.log(`probe: ${slug}: ${problems.length} problem(s)`);
    process.exit(1);
  }
  say(`ok - ${slug}${api.name ? ` (${api.name})` : ""} runs, alarms, resets, and its manual opens`);
})().catch((e) => {
  console.error(`probe: ${e.stack || e.message}`);
  process.exit(1);
});
