# Hermes Marine Route Explorer — public planning inspection surface

This static site is the **public, planning-only** inspection surface for the
accepted *Hermes marine route explorer* viewer plus the corresponding **#259
sanitized public bundle**, and the **#290 weekend planner** (A→B canonical
routes + a weekend weather/tide/sea-state conditions panel). It is served by
GitHub Pages from this `gh-pages` branch for the sole purpose of
demonstrating the viewer + planner + bundle without exposing any private
`hermes-config` content, credentials, or internal paths.

## Source of truth

The **private `willtwilson/hermes-config` repository** is the single source
of truth. This public repo contains **only** a frozen, allowlisted snapshot
of the publication assets, produced by the repeatable, allowlisted,
pre-publish-checked deploy pipeline that lives in that private repo. To
rebuild or refresh, re-run that pipeline and push the freshly assembled
tree here. Do NOT edit files in this public repo directly — they are
generated artifacts.

## Allowlist (exactly these files exist in this tree)

| file | origin |
|---|---|
| `index.html` | viewer page, incl. planning-aid + seamark non-authoritative notices, OpenFreeMap/OSM attribution |
| `app.js` | publish variant of the viewer logic (CONFIG.bundle -> `./data/*`) |
| `weekend-planner.html` | #290 weekend planner page (A→B selector + conditions panel; planning-aid + source/freshness disclaimers) |
| `planner.js` | #290 publish variant of the planner logic (PLANNER_CONFIG.bundle -> `./data/*` incl. conditions) |
| `data/routes.geojson` | #259 sanitized public bundle |
| `data/destinations.json` | #259 sanitized public bundle |
| `data/hazards.geojson` | #259 sanitized public bundle |
| `data/metadata.json` | #259 sanitized public bundle (freshness, source, counts) |
| `data/conditions.json` | #290 dynamic conditions snapshot (time-stamped, refreshed separately from routes) |
| `README.md` | this page |

No other files are meant to exist here. Anything else is out-of-band and
should be reported.

## Pre-publish checks (run by the pipeline before every push)

* **Strict denylist grep** over the `data/*` bundle files (routes,
  destinations, hazards, metadata) **and** the conditions snapshot: every
  token (`token, secret, berth, mooring, vessel, aura, password,
  private_key, api_key, apikey, credential, authorization, bearer,
  position, gps, ais, live, trip, internal, /opt, /root, /home, /etc`) —
  fail on ANY hit. `data/conditions.json` is scanned too because it is
  shipped in `data/`.
* **Artifact denylist** over the viewer + planner + this README: fail on any
  real private artifact (absolute private Unix/Windows paths, ssh/private
  keys, credential/API-key assignments). The planning-aid disclaimer and
  the browser-side list-of-rejected-tokens are public by design and are NOT
  re-flagged.
* **Path integrity** — the published `app.js` and `planner.js` reference
  only relative `./data/*` bundle paths (planner also re-points its
  conditions snapshot): no private-repo-relative paths, no
  absolute/private paths.
* **Bundle re-validation** with `public_bundle.validator.validate_bundle`
  on the staged `data/` directory (allowlist + denylist + structural
  invariants).

The deploy FAILS (never pushes) if any check reports a hit.

## Rebuild / publish

Re-run the deploy pipeline from the **private `hermes-config` repository**
(see that repo's own deploy documentation for the exact commands and the
safe dry-run / real-push distinction):

- a **dry-run** (the default) assembles + validates the allowlisted public
  tree and prints the plan and this site's URL — it never pushes;
- a **real push** (an explicit, reviewer-approved flag) publishes the tree
  to this repository's `gh-pages` branch and enables GitHub Pages to serve
  it from the root.

The pipeline requires only the Python standard library plus the stdlib-only
bundle validator. Pushes use the `gh`/`git` auth already configured on the
build host; **no credential is ever hard-coded or logged.**

Live site: https://willtwilson.github.io/ci-marine-explorer/

## Attribution

* Baseline map: **OpenFreeMap** (openfreemap.org) using **OpenStreetMap**
  data, © OpenStreetMap contributors (ODbL).
* Route/destination/hazard data: the **#259 sanitized public bundle** of the
  Channel Islands accepted marine route catalogue (#288) — compiled from
  clearly-public sources (Wikipedia / OpenStreetMap / Ramsar RIS) and
  geometrically validated. Public data only.

## Planning aid — NOT an official chart

**Planning aid only.** This viewer is not an official nautical chart and the
displayed routes are not a guarantee of navigational safety. They are
geometrically validated *planning* candidates. Use current official charts,
notices, pilotage information and prudent seamanship for navigation.
**Seamarks are informational only.** Seamark overlays are not an official
chart or routing authority and must not be used for navigation without an
official chart. No live vessel position, private berth/mooring coordinates or
personal trip history are published here.

## Weekend planner conditions (#290)

The weekend planner's **conditions panel** (weather / tide / sea-state) is a
planning aid. It reads a **separate, time-stamped conditions snapshot**
(`data/conditions.json`) distinct from the static route geometry. When the
snapshot is missing, stale, or in the "data pending" state the panel shows an
explicit **unavailable / stale / pending** label with the source + freshness
— it never fabricates numbers. Route geometry only changes when the #288
catalogue changes; the scheduled-refresh mechanism (`refresh_conditions.py`)
updates **only** the conditions snapshot and never the routes. The
conditions dimension needs free/public, re-distributable data and
**human/domain review before being relied on**.
