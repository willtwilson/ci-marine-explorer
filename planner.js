// #290 — Weekend planner: static A→B routes + weekend weather/tide/sea-state
// context. A lightweight static Pages planner that extends the #260 viewer.
//
// This planner is a PLANNING AID only. Route geometry/waypoints/distance/ETA
// come ONLY from the canonical #288 spine via the sanitized public bundle
// (the published ./data bundle: routes + destinations + hazards + metadata), read directly — it NEVER re-routes
// and NEVER modifies geometry in the browser. The direction of a canonical
// path may be reflected (reversed) deterministically, exactly like Hermes'
// route_catalogue_runtime._reflect. Unsupported pairs render an explicit
// "no path" diagnostic with NO fabricated geometry. The conditions panel shows
// weekend weather/tide/sea-state context from the dynamic conditions snapshot
// (conditions.json) with source + freshness labels and VISIBLE stale / missing
// degradation — it never invents numbers, and it never declares any output
// "safe".
//
// It imports the pure helpers from the #260 viewer (app.js) so the render /
// validation / inspection logic is shared and stays in step: validateBundle,
// haversineKm, initialBearing. app.js auto-starts only when its own #260 page
// containers are present, so importing it here is side-effect-free.
import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.9.0/dist/maplibre-gl.mjs';
import { validateBundle, haversineKm, initialBearing } from './app.js';

const PLANNER_CONFIG = Object.freeze({
  basemap: {
    provider: 'OpenFreeMap',
    styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
    attribution: 'Basemap: OpenFreeMap · Map data © OpenStreetMap contributors',
  },
  // Read-only inputs from the #288/#259 canonical spine. Paths are relative to
  // the repository root (serve with `python3 -m http.server` from the root).
  bundle: {
    routes: './data/routes.geojson',
    destinations: './data/destinations.json',
    hazards: './data/hazards.geojson',
    metadata: './data/metadata.json',
    conditions: './data/conditions.json',
  },
  // Default planning speed used ONLY to derive a planning ETA from the
  // canonical distance. This is a planning estimate, not a schedule and not
  // a "go / no-go" recommendation. The user can change it.
  planningSpeedKnots: 6,
});

const KM_PER_NM = 1.852;

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------
function $(id) { return document.getElementById(id); }

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function clearRows(id) {
  const el = $(id);
  if (el) el.textContent = '';
}

function addRow(id, label, value) {
  const el = $(id);
  if (!el) return;
  const div = document.createElement('div');
  div.className = 'planner-row';
  const k = document.createElement('span');
  k.textContent = label;
  const v = document.createElement('strong');
  v.textContent = value;
  div.append(k, v);
  el.appendChild(div);
}

function setClassBadge(el, className, text) {
  el.className = '';
  el.classList.add('cond-badge', className);
  el.textContent = text;
}

// ---------------------------------------------------------------------------
// Pair resolution (read-only lookup into the canonical bundle — no routing)
// ---------------------------------------------------------------------------
function findPairFeature(routes, origin, destination) {
  if (!origin || !destination) return null;
  for (const feature of routes) {
    const props = feature.properties;
    // The bundle stores each unordered pair once in canonical src_id->dst_id
    // order. Match the unordered pair {origin, destination}.
    const a = props.src_id;
    const b = props.dst_id;
    if ((a === origin && b === destination) ||
        (a === destination && b === origin)) {
      return feature;
    }
  }
  return null;
}

// Orient a supported feature's geometry so it runs origin -> destination by
// deterministically reflecting (reversing) the canonical LineString when the
// canonical record is stored destination -> origin. This is the SAME
// deterministic reversal as Hermes' route_catalogue_runtime._reflect and does
// NOT create or modify any geometry in the browser.
function orientLineString(coordinates, wantsOriginFirst, origin) {
  if (wantsOriginFirst) return coordinates;
  return coordinates.slice().reverse();
}

// ---------------------------------------------------------------------------
// Conditions panel (#326): live weather + sea state, provenance + freshness
// ---------------------------------------------------------------------------
// Every rendered value is FCT (forecast/model output) from an EXPLICITLY named
// model, with retrieval + model-run timestamps. This code NEVER declares
// anything safe to sail, never gives a go/no-go answer, and never presents Hs
// as a maximum wave height. Tide has no approved source and always renders as
// unavailable with official-source links only.
const DISPLAY_TZ = 'Europe/Jersey';

function conditionsState(conditions) {
  // Normalise: missing/unparseable snapshot => explicit "unavailable" state.
  if (!conditions || typeof conditions !== 'object') {
    return { status: 'unavailable', reason: 'no snapshot', generatedAt: null,
      dims: {}, schemaVersion: null };
  }
  const status = conditions.status || 'unavailable';
  const dims = (conditions && conditions.dimensions) || {};
  return {
    status,
    reason: null,
    generatedAt: conditions.generated_at || null,
    schemaVersion: conditions.schema_version || null,
    dims,
  };
}

function staleLabel(state) {
  switch (state.status) {
    case 'fresh':
      return 'Fresh — retrieved and model run within thresholds';
    case 'partial':
      return 'Partial — some fields unavailable (n/a)';
    case 'stale':
      return 'Stale — refresh or model run too old';
    case 'unavailable':
      return 'Unavailable — no usable conditions data';
    case 'pending':
      return 'Conditions data pending — free/public source required';
    default:
      return 'Conditions unavailable';
  }
}

function badgeClass(status) {
  switch (status) {
    case 'fresh': return 'fresh';
    case 'partial': return 'partial';
    case 'stale': return 'stale';
    case 'pending': return 'pending';
    default: return 'missing';
  }
}

// Canonical UTC ISO-8601 -> Europe/Jersey local display (GMT/BST). UTC remains
// derivable from what is shown: the UTC value is rendered alongside the local.
function formatLocal(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: DISPLAY_TZ, dateStyle: 'medium', timeStyle: 'short',
      timeZoneName: 'short',
    }).format(d);
  } catch (_e) {
    return null;  // caller falls back to showing UTC only
  }
}

function formatUtc(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toISOString().replace('.000Z', 'Z');
}

function stampText(iso) {
  if (!iso) return 'not stated';
  const local = formatLocal(iso);
  const utc = formatUtc(iso);
  return local ? `${local} (${utc} UTC)` : `${utc} UTC`;
}

function ageHours(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / 3600000;
}

function ageText(iso) {
  const h = ageHours(iso);
  if (h === null) return 'age unknown';
  if (h < 0) return 'timestamp in the future';
  if (h < 1) return `${Math.round(h * 60)} min ago`;
  return `${h.toFixed(1)} h ago`;
}

// Approved precision: kt integer, Hs 0.1 m, periods integer seconds,
// direction FROM in true degrees rounded to the nearest 10 deg + cardinal.
function fmtInt(v, unit) {
  return Number.isFinite(v) ? `${Math.round(v)} ${unit}` : 'n/a';
}
function fmtTenths(v, unit) {
  return Number.isFinite(v) ? `${Number(v).toFixed(1)} ${unit}` : 'n/a';
}
function fmtDir(deg, cardinal) {
  if (!Number.isFinite(deg)) return 'n/a';
  const rounded = ((Math.round(deg / 10) * 10) % 360 + 360) % 360;
  return cardinal
    ? `${rounded}° (${cardinal}) FROM` : `${rounded}° FROM`;
}
function fmtDeg(deg) {
  if (!Number.isFinite(deg)) return 'n/a';
  return `${((Math.round(deg / 10) * 10) % 360 + 360) % 360}°`;
}

const LABEL_LEGEND = 'FCT = forecast/model output · OBS = observation';

// One series row (hourly). Optional missing fields show an explicit n/a.
function addSeriesRow(container, series, fields, title) {
  if (!series) return;
  const div = document.createElement('div');
  div.className = 'cond-series';
  const head = document.createElement('div');
  head.className = 'cond-series-head';
  head.textContent = title;
  div.appendChild(head);
  for (const f of fields) {
    const row = document.createElement('div');
    row.className = 'planner-row';
    const k = document.createElement('span');
    k.textContent = f.label;
    const v = document.createElement('strong');
    v.textContent = f.render(series) ?? 'n/a';
    row.append(k, v);
    div.appendChild(row);
  }
  container.appendChild(div);
}

function renderDimension(container, key, dim) {
  const title = key === 'sea_state' ? 'Sea state' : 'Weather';
  const status = (dim && dim.status) || 'unavailable';
  const badge = document.createElement('span');
  badge.className = `cond-badge ${badgeClass(status)}`;
  badge.textContent = `${title}: ${status}`;
  container.appendChild(badge);

  if (!dim || status === 'unavailable') {
    addRow(container, `${title} source`,
      (dim && dim.source) || 'no approved source wired');
    addRow(container, 'Reason', (dim && dim.notes) || 'no data');
    return;
  }

  // Provenance: provider + explicit model, with fallbacks recorded.
  addRow(container, 'Provider', dim.provider || 'n/a');
  addRow(container, 'Model (explicit)', dim.model || 'n/a');
  if (dim.model_selection) addRow(container, 'Model selection', dim.model_selection);
  if (dim.model_fallback_used) {
    addRow(container, 'Fallback', 'yes — primary model unavailable; provenance '
      + 'reflects the model actually used (never averaged)');
  }
  if (Array.isArray(dim.provider_attempts) && dim.provider_attempts.length) {
    addRow(container, 'Provider attempts',
      dim.provider_attempts.map((a) => `${a.model}: ${a.outcome}`).join(' · '));
  }
  addRow(container, 'Retrieved at', `${stampText(dim.retrieved_at)} · `
    + `${ageText(dim.retrieved_at)}`);
  addRow(container, 'Model run at', `${stampText(dim.source_run_at)} · `
    + `${ageText(dim.source_run_at)}`);
  addRow(container, 'Values', LABEL_LEGEND);
  if (Array.isArray(dim.fields_missing) && dim.fields_missing.length) {
    addRow(container, 'Missing fields',
      `${dim.fields_missing.join(', ')} (rendered n/a — dimension is partial)`);
  }
  if (dim.sample && Number.isFinite(dim.sample.lat)) {
    addRow(container, 'Sample point',
      `${dim.sample.lat.toFixed(2)}, ${dim.sample.lon.toFixed(2)} `
      + '(single provider point — no interpolation by Hermes)');
  }
  if (key === 'weather') {
    for (const s of (dim.series || [])) {
      addSeriesRow(container, s, [
        { label: 'Valid at (FCT)', render: (x) => stampText(x.valid_at) },
        { label: 'Wind (FCT)', render: (x) => fmtInt(x.wind_kt, 'kt') },
        { label: 'Gust (FCT)', render: (x) => fmtInt(x.gust_kt, 'kt') },
        { label: 'Wind from (FCT)',
          render: (x) => fmtDir(x.wind_dir_from_deg, x.wind_dir_from_cardinal) },
      ], `Hourly weather — ${formatUtc(s.valid_at)} UTC`);
    }
  } else if (key === 'sea_state') {
    for (const s of (dim.series || [])) {
      addSeriesRow(container, s, [
        { label: 'Valid at (FCT)', render: (x) => stampText(x.valid_at) },
        { label: 'Hs (FCT)', render: (x) => fmtTenths(x.hs_m, 'm') },
        { label: 'Wave period (FCT)',
          render: (x) => fmtInt(x.wave_period_s, 's') },
        { label: 'Wave from (FCT)',
          render: (x) => fmtDir(x.wave_dir_from_deg, x.wave_dir_from_cardinal) },
        { label: 'Swell Hs (FCT)', render: (x) => fmtTenths(x.swell_hs_m, 'm') },
        { label: 'Swell period (FCT)',
          render: (x) => fmtInt(x.swell_period_s, 's') },
        { label: 'Swell from (FCT)',
          render: (x) => fmtDir(x.swell_dir_from_deg, x.swell_dir_from_cardinal) },
        { label: 'Wind-wave Hs (FCT)',
          render: (x) => fmtTenths(x.wind_wave_hs_m, 'm') },
      ], `Hourly sea state — ${formatUtc(s.valid_at)} UTC`);
    }
    addRow(container, 'Wave height meaning',
      'Hs = significant wave height (mean of the highest third). It is NOT a '
      + 'maximum wave height; individual waves can exceed it.');
  }
}

function renderTide(container, dim) {
  const badge = document.createElement('span');
  badge.className = 'cond-badge missing';
  badge.textContent = 'Tide: unavailable';
  container.appendChild(badge);
  addRow(container, 'Status', 'unavailable — no approved prediction source');
  addRow(container, 'Note', (dim && dim.note) ||
    'No approved free/re-distributable Channel Islands tide prediction source.');
  addRow(container, 'Sea-level model values',
    'never used — sea_level_height_msl is MSL-referenced and unsuitable for '
    + 'coastal navigation (not inferred here)');
  const links = (dim && dim.reference_links) || [];
  const wrap = document.createElement('div');
  wrap.className = 'planner-row cond-links';
  const k = document.createElement('span');
  k.textContent = 'Official sources (reference only)';
  wrap.appendChild(k);
  const list = document.createElement('strong');
  if (!links.length) {
    list.textContent = 'none listed';
  } else {
    links.forEach((l, i) => {
      if (i) list.appendChild(document.createTextNode(' · '));
      const a = document.createElement('a');
      a.href = l.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = l.label;
      list.appendChild(a);
    });
  }
  wrap.appendChild(list);
  container.appendChild(wrap);
  addRow(container, 'Reuse', 'links are reference-only — official forecast '
    + 'text is never auto-republished');
}

function renderConditions(conditions) {
  const state = conditionsState(conditions);
  const badge = $('conditions-badge');
  const sourceEl = $('conditions-source');
  const freshnessEl = $('conditions-freshness');
  const valuesEl = $('conditions-values');
  const noteEl = $('conditions-note');

  setClassBadge(badge, badgeClass(state.status), staleLabel(state));

  const generated = state.generatedAt
    ? `${stampText(state.generatedAt)} · ${ageText(state.generatedAt)}`
    : 'not stated';
  freshnessEl.textContent = `Snapshot generated: ${generated}`;

  if (state.status === 'unavailable' && !Object.keys(state.dims).length) {
    sourceEl.textContent = 'Source: none — conditions snapshot missing or '
      + 'unparseable';
    clearRows(valuesEl);
    if (noteEl) {
      noteEl.textContent = 'Conditions are unavailable: the snapshot could not '
        + 'be read. No weather, sea-state or tide value is fabricated — every '
        + 'dimension degrades visibly. Routes are unaffected.';
    }
    return;
  }

  const dims = state.dims;
  sourceEl.textContent = `Schema ${state.schemaVersion || 'unspecified'} · `
    + 'canonical times UTC, displayed Europe/Jersey (GMT/BST)';

  clearRows(valuesEl);
  if (dims.weather) renderDimension(valuesEl, 'weather', dims.weather);
  if (dims.sea_state) renderDimension(valuesEl, 'sea_state', dims.sea_state);
  if (dims.tide) renderTide(valuesEl, dims.tide);

  if (noteEl) {
    noteEl.textContent = 'Planning context only — FCT (model forecast) values '
      + 'from explicitly named models, with retrieval and model-run times so '
      + 'freshness is auditable. This is not a navigation product, not a '
      + 'go / no-go decision and nothing here is described as safe. Use '
      + 'official forecasts, charts and warnings.';
  }
}

// ---------------------------------------------------------------------------
// Route rendering (reuses #260 layer/style patterns via the shared helpers)
// ---------------------------------------------------------------------------
let map = null;
let routeSourceId = 'planner-route';
let endpointSourceId = 'planner-endpoints';

function clearRoute(mapInstance) {
  if (!mapInstance) return;
  if (mapInstance.getSource(routeSourceId)) {
    mapInstance.getSource(routeSourceId).setData({
      type: 'FeatureCollection', features: [] });
  }
  if (mapInstance.getSource(endpointSourceId)) {
    mapInstance.getSource(endpointSourceId).setData({
      type: 'FeatureCollection', features: [] });
  }
}

function renderRoute(mapInstance, bundle, origin, destination) {
  const metricsEl = $('planner-metrics');
  const diagEl = $('planner-diagnostic');
  clearRows(metricsEl);
  clearRows(diagEl);
  diagEl.hidden = false;
  clearRoute(mapInstance);

  if (!origin || !destination) {
    setText('planner-diagnostic-txt',
      'Choose an origin and a destination to inspect the canonical route.');
    return;
  }
  if (origin === destination) {
    setText('planner-diagnostic-txt',
      'Origin and destination are the same — there is no route to plan.');
    return;
  }

  const feature = findPairFeature(bundle.routes.features, origin, destination);
  if (!feature) {
    setText('planner-diagnostic-txt',
      `No catalogue entry for ${origin} -> ${destination}. ` +
      'This pair is not between two supported public destinations.');
    return;
  }

  const props = feature.properties;
  if (props.state !== 'supported') {
    // Explicit unsupported / no-path diagnostic. NEVER any geometry.
    setText('planner-diagnostic-txt',
      `Unsupported — no path: ${props.src_id} -> ${props.dst_id}. ` +
      `Reason: ${props.reason || 'no public path exists'}. ` +
      'No route is drawn because no path exists in the public bundle.');
    return;
  }

  // Supported: render the CANONICAL geometry, reflected to origin->destination.
  diagEl.hidden = true;
  const canonicalFirstIsOrigin = props.src_id === origin;
  const coords = orientLineString(
    feature.geometry.coordinates, canonicalFirstIsOrigin, origin);

  const routeFeature = {
    type: 'Feature',
    properties: {
      pair_id: props.pair_id,
      state: props.state,
    },
    geometry: {
      type: 'LineString',
      coordinates: coords,
    },
  };
  // Endpoints from the canonical bundle's own coordinates (first / last point).
  const endpointFeatures = [
    { type: 'Feature', properties: { role: 'origin' },
      geometry: { type: 'Point', coordinates: coords[0] } },
    { type: 'Feature', properties: { role: 'destination' },
      geometry: { type: 'Point', coordinates: coords[coords.length - 1] } },
  ];

  mapInstance.getSource(routeSourceId).setData({
    type: 'FeatureCollection', features: [routeFeature] });
  mapInstance.getSource(endpointSourceId).setData({
    type: 'FeatureCollection', features: endpointFeatures });

  // Metrics from the CANONICAL bundle properties.
  const distanceKm = props.distance_km;
  const distanceNm = props.distance_nm;
  const waypointCount = props.waypoint_count;
  const speedInput = $('planning-speed');
  const speedKnots = speedInput && Number(speedInput.value)
    ? Number(speedInput.value) : PLANNER_CONFIG.planningSpeedKnots;
  const etaHours = (typeof distanceKm === 'number' && Number.isFinite(distanceKm))
    ? distanceKm / (speedKnots * KM_PER_NM)
    : null;

  addRow(metricsEl, 'Origin', origin);
  addRow(metricsEl, 'Destination', destination);
  addRow(metricsEl, 'Distance', formatKm(distanceKm));
  addRow(metricsEl, 'Distance (nm)', formatNm(distanceNm));
  addRow(metricsEl, 'Waypoints', waypointCount != null ? String(waypointCount) : '—');
  addRow(metricsEl, 'Planning ETA', etaHours != null
    ? `${humanHours(etaHours)} @ ${speedKnots} kn`
    : 'No canonical distance');

  // Fit the camera to the canonical geometry.
  const bounds = new maplibregl.LngLatBounds();
  coords.forEach((c) => bounds.extend(c));
  if (!bounds.isEmpty()) {
    mapInstance.fitBounds(bounds, {
      padding: 48, maxZoom: 12, duration: 350 });
  }
}

function formatKm(km) {
  return (typeof km === 'number' && Number.isFinite(km))
    ? `${km.toFixed(2)} km` : '—';
}
function formatNm(nm) {
  return (typeof nm === 'number' && Number.isFinite(nm))
    ? `${nm.toFixed(2)} nm` : '—';
}
function humanHours(h) {
  const totalMin = Math.round(h * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return `${hh}h ${String(mm).padStart(2, '0')}m`;
}

// ---------------------------------------------------------------------------
// Destination dropdowns (exactly the 11 supported public destinations)
// ---------------------------------------------------------------------------
function fillDestinationSelect(selectEl, destinations, placeholder, selectedName) {
  selectEl.textContent = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = placeholder;
  selectEl.appendChild(ph);
  for (const d of destinations) {
    const opt = document.createElement('option');
    // Route records in the canonical bundle key pairs by the PUBLIC NAME
    // (src_id / dst_id == destination name), so the select value is the name.
    opt.value = d.name;
    opt.textContent = d.name;
    if (d.name === selectedName) opt.selected = true;
    selectEl.appendChild(opt);
  }
  return selectEl.options.length - 1; // number of real destinations
}

function bindPlanner(mapInstance, bundle) {
  const originSel = $('planner-origin');
  const destSel = $('planner-destination');
  const supported = [...bundle.destinations].sort((x, y) =>
    x.name.localeCompare(y.name));

  fillDestinationSelect(originSel, supported, 'Select origin…', 'St Aubin');
  fillDestinationSelect(destSel, supported, 'Select destination…', 'St Brelade');
  $('planner-destination-count').textContent =
    `${supported.length} supported public destinations`;

  const update = () =>
    renderRoute(mapInstance, bundle, originSel.value, destSel.value);
  originSel.addEventListener('change', update);
  destSel.addEventListener('change', update);
  $('planning-speed').addEventListener('input', update);
  update();
}

// ---------------------------------------------------------------------------
// Map + boot
// ---------------------------------------------------------------------------
function addPlannerMap() {
  map = new maplibregl.Map({
    container: 'planner-map',
    style: PLANNER_CONFIG.basemap.styleUrl,
    center: [-1.95, 49.28],
    zoom: 8,
    attributionControl: false,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
  map.addControl(new maplibregl.AttributionControl({
    compact: false,
    customAttribution: PLANNER_CONFIG.basemap.attribution,
  }), 'bottom-right');

  map.on('load', () => {
    map.addSource(routeSourceId, {
      type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource(endpointSourceId, {
      type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'planner-route-line', type: 'line', source: routeSourceId,
      paint: { 'line-color': '#1463ff', 'line-width': 4, 'line-opacity': 0.9 },
    });
    map.addLayer({
      id: 'planner-route-waypoints', type: 'circle', source: routeSourceId,
      paint: {
        'circle-radius': 3.5, 'circle-color': '#ffffff',
        'circle-stroke-color': '#1463ff', 'circle-stroke-width': 1.5,
      },
    });
    map.addLayer({
      id: 'planner-endpoints', type: 'circle', source: endpointSourceId,
      paint: {
        'circle-radius': 6, 'circle-color': '#0a7d36',
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5,
      },
    });

    // Inspection: click a leg / waypoint / endpoint to show canonical metadata.
    map.on('click', 'planner-route-line', (e) => {
      if (!e.features || !e.features.length) return;
      const props = e.features[0].properties;
      showInspection([
        ['Leg', props.pair_id],
        ['State', props.state],
        ['Geometry source', 'Canonical #288 public bundle — read-only'],
      ]);
    });

    const mapReady = new CustomEvent('planner-map-ready');
    window.dispatchEvent(mapReady);
  });
  return map;
}

function showInspection(rows) {
  const el = $('planner-inspection');
  el.textContent = '';
  rows.forEach(([label, value]) => addRow('planner-inspection', label, value));
}

async function loadPlannerBundle() {
  const paths = PLANNER_CONFIG.bundle;
  // Conditions is optional/dynamic — a fetch failure must NOT block the
  // planner; it degrades the conditions panel explicitly.
  let conditions = null;
  try {
    const condRes = await fetch(paths.conditions, { cache: 'no-store' });
    if (condRes.ok) conditions = await condRes.json();
  } catch (_e) {
    conditions = null;
  }

  const [routesRes, destRes, hazRes, metaRes] = await Promise.all([
    fetch(paths.routes, { cache: 'no-store' }),
    fetch(paths.destinations, { cache: 'no-store' }),
    fetch(paths.hazards, { cache: 'no-store' }),
    fetch(paths.metadata, { cache: 'no-store' }),
  ]);
  const ok = [routesRes, destRes, hazRes, metaRes].every((r) => r.ok);
  if (!ok) throw new Error('One or more planner bundle files could not be fetched.');
  const bundle = {
    routes: await routesRes.json(),
    destinations: await destRes.json(),
    hazards: await hazRes.json(),
    metadata: await metaRes.json(),
  };
  return { bundle: validateBundle(bundle), conditions };
}

async function start() {
  const errorBox = $('planner-error');
  try {
    const { bundle, conditions } = await loadPlannerBundle();
    updateHeader(bundle);
    renderConditions(conditions);
    const plMap = addPlannerMap();
    plMap.on('load', () => {
      bindPlanner(plMap, bundle);
    });
  } catch (error) {
    errorBox.hidden = false;
    errorBox.textContent = `Weekend planner could not load: ${error.message}`;
    console.error(error);
  }
}

function updateHeader(bundle) {
  const counts = bundle.metadata.counts || {};
  setText('planner-title', 'Weekend boat planner — A to B');
  setText('planner-subtitle',
    'Canonical #288 routes over the public bundle — planning aid only');
  setText('planner-meta', `Bundle: ${bundle.metadata.bundle_name || '—'} · ` +
    `${counts.routes ?? '?'} pairs · generated by ` +
    `${bundle.metadata.generator || '—'} v${bundle.metadata.generator_version || '—'} ` +
    `· freshness: ${bundle.metadata.freshness || '—'}. ` +
    'Conditions are separate, refreshable and time-stamped; routes are static.');
}

start();
