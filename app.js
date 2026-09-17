import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.9.0/dist/maplibre-gl.mjs';

// #260 — MapLibre marine planning-overlay viewer.
// Consumes ONLY the #259 sanitized public bundle fixture
// (data/routes.geojson + data/destinations.json + data/hazards.geojson + data/metadata.json — the published ./data bundle). This is a planning-only,
// geometrically-validated inspection surface — NOT a chart and NOT a routing
// authority. No live position, no private data, no paid map service.
//
// Layer architecture note (future overlay hooks):
//   Every named layer is registered in the LAYER_REGISTRY below with a stable
//   source id and a toggle label. Later depth/UKC, weather-sample and
//   tidal-stream overlays drop in as sibling layers: add a source + an
//   addLayer block that reads from a new `source` id, then register it here.
//   The generic toggle control flips map.setLayoutProperty(...).
const CONFIG = Object.freeze({
  basemap: {
    provider: 'OpenFreeMap',
    styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
    attribution: 'Basemap: OpenFreeMap · Map data © OpenStreetMap contributors',
  },
  // #259 sanitized public bundle fixture files (read-only inputs). Paths are
  // relative to the repo root — serve with `python3 -m http.server` from the
  // repository root and open the published index.html from this tree
  bundle: {
    routes: './data/routes.geojson',
    destinations: './data/destinations.json',
    hazards: './data/hazards.geojson',
    metadata: './data/metadata.json',
  },
  // Optional future seamark data feed. When present, load it into the
  // 'seamarks-src' source. Left unset (null) so the viewer never fabricates
  // seamarks; the layer stays registered and explicitly non-authoritative.
  seamarksUrl: null,
});

// ---------------------------------------------------------------------------
// Privacy / schema validation (browser-side, adapted to the #259 bundle).
// The exporter already enforces an explicit allowlist + denylist server-side;
// this repeats the safety checks in the browser before rendering so a
// malformed or regressed bundle fails loudly instead of painting private data.
// ---------------------------------------------------------------------------
const ALLOWED_ROUTE_PROPS = ['pair_id', 'src_id', 'dst_id', 'state', 'reason',
  'distance_km', 'distance_nm', 'waypoint_count', 'validation_authority'];
const ALLOWED_DEST_FIELDS = ['id', 'name', 'display_point', 'routing_portal',
  'classification'];
const ALLOWED_HAZARD_PROPS = ['id', 'name', 'class', 'source_type', 'licence',
  'provenance'];
const ALLOWED_METADATA_FIELDS = ['schema_version', 'bundle_name', 'generator',
  'generator_version', 'catalogue_provenance_key', 'catalogue_build_id',
  'compiler', 'compiler_version', 'hazard_note', 'source', 'freshness',
  'counts', 'files'];
const ROUTE_STATES = new Set(['supported', 'unsupported_no_path',
  'unsupported_validation_failed']);
const HAZARD_CLASSES = new Set(['hard_exclusion', 'clearance_exclusion',
  'navigation_aid', 'unknown_unverified']);
// Denylisted private keys: any key (or nested key) containing one of these
// tokens causes the whole bundle to be REJECTED before rendering.
const FORBIDDEN_KEY_TOKENS = ['token', 'secret', 'berth', 'vessel', 'mooring',
  'anchor', 'aura', 'trip', 'voyage', 'track', 'person', 'owner', 'crew',
  'draft', 'mast', 'password', 'passwd', 'apikey', 'api_key', 'credential',
  'authorization', 'bearer', 'privkey', 'private_key', 'live', 'gps', 'ais',
  'position', 'internal', '/opt', '/root', '/home', '/etc'];

function collectKeys(value, output = new Set(), path = 'root') {
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectKeys(item, output, `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, child]) => {
      output.add(key.toLowerCase());
      collectKeys(child, output, `${path}.${key}`);
    });
  }
  return output;
}

function rejectIfForbiddenKeys(data) {
  const keys = collectKeys(data);
  const hits = [...keys].filter((key) =>
    FORBIDDEN_KEY_TOKENS.some((token) => key.includes(token)));
  if (hits.length) {
    throw new Error(`Private field(s) detected — bundle rejected before ` +
      `rendering: ${hits.join(', ')}`);
  }
}

function assertSubset(obj, allowed, what) {
  const unexpected = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unexpected.length) {
    throw new Error(`${what} contains non-allowlisted field(s): ` +
      `${unexpected.join(', ')}`);
  }
}

function validateFiniteCoord(coord, what) {
  if (!Array.isArray(coord) || coord.length < 2) {
    throw new Error(`${what} coordinate must be [lon, lat].`);
  }
  const [lon, lat] = coord;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new Error(`${what} coordinate is not finite.`);
  }
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    throw new Error(`${what} coordinate out of range.`);
  }
}

export function validateBundle(bundle) {
  if (!bundle) throw new Error('Bundle is empty.');
  if (!bundle.routes || bundle.routes.type !== 'FeatureCollection' ||
      !Array.isArray(bundle.routes.features)) {
    throw new Error('routes.geojson must be a GeoJSON FeatureCollection.');
  }
  if (!bundle.hazards || bundle.hazards.type !== 'FeatureCollection' ||
      !Array.isArray(bundle.hazards.features)) {
    throw new Error('hazards.geojson must be a GeoJSON FeatureCollection.');
  }
  if (!Array.isArray(bundle.destinations)) {
    throw new Error('destinations.json must be an array.');
  }
  if (!bundle.metadata || bundle.metadata.schema_version !== '1.0') {
    throw new Error('metadata.json must carry schema_version "1.0".');
  }
  rejectIfForbiddenKeys(bundle);

  // Routes: properties allowlist, state values, geometry presence/finiteness.
  for (const feature of bundle.routes.features) {
    const props = feature.properties || {};
    assertSubset(props, ALLOWED_ROUTE_PROPS, 'route feature');
    if (!ROUTE_STATES.has(props.state)) {
      throw new Error(`Unsupported route state '${props.state}'.`);
    }
    if (props.state === 'supported') {
      if (!feature.geometry || feature.geometry.type !== 'LineString' ||
          feature.geometry.coordinates.length < 2) {
        throw new Error(`Supported route '${props.pair_id}' must carry a ` +
          'LineString with >= 2 coordinates.');
      }
      feature.geometry.coordinates.forEach((c) =>
        validateFiniteCoord(c, `route '${props.pair_id}'`));
    } else {
      if (feature.geometry) {
        throw new Error(`Unsupported route '${props.pair_id}' must NOT carry ` +
          'geometry.');
      }
    }
  }

  // Destinations: field allowlist + finite display/routing_portal coords.
  for (const dest of bundle.destinations) {
    assertSubset(dest, ALLOWED_DEST_FIELDS, 'destination');
    validateFiniteCoord(dest.display_point, `destination '${dest.id}'`);
    validateFiniteCoord(dest.routing_portal, `destination '${dest.id}'`);
  }

  // Hazards: field allowlist + allowed class + finite polygon/point geometry.
  for (const feature of bundle.hazards.features) {
    const props = feature.properties || {};
    assertSubset(props, ALLOWED_HAZARD_PROPS, 'hazard feature');
    if (!HAZARD_CLASSES.has(props.class)) {
      throw new Error(`Unsupported hazard class '${props.class}'.`);
    }
    if (!feature.geometry) throw new Error('Hazard feature missing geometry.');
    validateGeometry(feature.geometry, `hazard '${props.id}'`, 'Polygon');
  }

  // Metadata: allowlist.
  assertSubset(bundle.metadata, ALLOWED_METADATA_FIELDS, 'metadata');
  return bundle;
}

function validateGeometry(geometry, what, expectedType) {
  if (!geometry.type) throw new Error(`${what} geometry has no type.`);
  if (expectedType) {
    const ok =
      geometry.type === expectedType ||
      (geometry.type === 'MultiPolygon' && expectedType === 'Polygon');
    if (!ok) throw new Error(`${what} geometry type is ${geometry.type}.`);
  }
  visitCoordinateArrays(geometry.coordinates, (coord) =>
    validateFiniteCoord(coord, what));
}

function visitCoordinateArrays(coords, fn) {
  if (!Array.isArray(coords)) return;
  // Leaf coordinate: [lon, lat, ...] — its first element is a number.
  if (typeof coords[0] === 'number') { fn(coords); return; }
  // Otherwise recurse into nested arrays (rings / line strings / points).
  if (Array.isArray(coords[0])) {
    coords.forEach((child) => visitCoordinateArrays(child, fn));
  }
}

// ---------------------------------------------------------------------------
// Geometric helpers (allowed derivation from existing coordinates — NOT a
// routing algorithm). Bearing and haversine distance for a single leg.
// ---------------------------------------------------------------------------
function toRad(deg) { return (deg * Math.PI) / 180; }
function toDeg(rad) { return (rad * 180) / Math.PI; }

export function haversineKm(a, b) {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const R = 6371.0088; // mean Earth radius, km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function initialBearing(a, b) {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// ---------------------------------------------------------------------------
// Layer registry — the single place that defines every layer + its toggle.
// To add a future overlay (depth/UKC, weather-sample, tidal-stream):
//   1. add its source,
//   2. add a named addLayer block below,
//   3. register it here with a stable id + label + default visibility.
// The generic toggle control then manages it automatically.
// ---------------------------------------------------------------------------
const LAYER_REGISTRY = [
  { id: 'route-legs', label: 'Planning routes (supported)', group: 'Layers',
    defaultOn: true, source: 'routes-src' },
  { id: 'route-unsupported', label: 'Unsupported pairs (no path)', group: 'Layers',
    defaultOn: true, source: 'unsupported-src' },
  { id: 'land-exclusion', label: 'Land & hard exclusion', group: 'Layers',
    defaultOn: true, source: 'hazards-src' },
  { id: 'hazards-uncertainty', label: 'Hazards & uncertainty', group: 'Layers',
    defaultOn: true, source: 'hazards-src' },
  { id: 'destinations', label: 'Destinations', group: 'Layers',
    defaultOn: true, source: 'destinations-src' },
  { id: 'seamarks', label: 'Seamarks (informational)', group: 'Layers',
    defaultOn: false, source: 'seamarks-src' },
];

const LAYER_BY_ID = Object.fromEntries(LAYER_REGISTRY.map((l) => [l.id, l]));

const SOURCE_IDS = Object.freeze({
  routes: 'routes-src',
  unsupported: 'unsupported-src',
  hazards: 'hazards-src',
  destinations: 'destinations-src',
  seamarks: 'seamarks-src',
});

// ---------------------------------------------------------------------------
// Bundle-to-sources: build the rendered FeatureCollections from the fixture.
// ---------------------------------------------------------------------------
function buildRouteFeatureCollection(routes) {
  const features = [];
  for (const feature of routes) {
    const props = feature.properties;
    if (props.state === 'supported') {
      features.push({
        type: 'Feature',
        properties: props,
        geometry: feature.geometry,
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

function buildUnsupportedFeatureCollection(routes, destinations) {
  const byId = Object.fromEntries(destinations.map((d) => [d.id, d]));
  const features = [];
  for (const feature of routes) {
    const props = feature.properties;
    if (props.state !== 'supported') {
      const src = byId[props.src_id];
      const dst = byId[props.dst_id];
      // Render the two public portal endpoints (existing coordinates from the
      // bundle) as a diagnostic — NEVER a fabricated path between them.
      for (const [role, dest] of [['src', src], ['dst', dst]]) {
        if (!dest) continue;
        features.push({
          type: 'Feature',
          properties: { ...props, endpointRole: role },
          geometry: { type: 'Point', coordinates: dest.display_point },
        });
      }
    }
  }
  return { type: 'FeatureCollection', features };
}

function buildHazardFeatureCollection(hazards) {
  return { type: 'FeatureCollection', features: hazards };
}

function buildDestinationFeatureCollection(destinations) {
  return {
    type: 'FeatureCollection',
    features: destinations.map((d) => ({
      type: 'Feature',
      properties: d,
      geometry: { type: 'Point', coordinates: d.display_point },
    })),
  };
}

// ---------------------------------------------------------------------------
// Layer construction. Every addLayer block has a stable source id and is
// registered in LAYER_REGISTRY so the generic toggle control manages it.
// ---------------------------------------------------------------------------
function addSources(map, bundle, seamarkFeatures) {
  map.addSource(SOURCE_IDS.routes, {
    type: 'geojson',
    data: buildRouteFeatureCollection(bundle.routes.features),
  });
  map.addSource(SOURCE_IDS.unsupported, {
    type: 'geojson',
    data: buildUnsupportedFeatureCollection(bundle.routes.features,
      bundle.destinations),
  });
  map.addSource(SOURCE_IDS.hazards, {
    type: 'geojson',
    data: buildHazardFeatureCollection(bundle.hazards.features),
  });
  map.addSource(SOURCE_IDS.destinations, {
    type: 'geojson',
    data: buildDestinationFeatureCollection(bundle.destinations),
  });
  map.addSource(SOURCE_IDS.seamarks, {
    type: 'geojson',
    data: seamarkFeatures || { type: 'FeatureCollection', features: [] },
  });
}

function addRouteLegsLayer(map) {
  map.addLayer({
    id: 'route-legs',
    type: 'line',
    source: SOURCE_IDS.routes,
    paint: {
      'line-color': '#1463ff',
      'line-width': 4,
      'line-opacity': 0.9,
    },
  });
}

function addRouteWaypointsLayer(map) {
  // Waypoints along supported planned legs (geometrically derived from the
  // LineString coordinates — not a routing algorithm).
  map.addLayer({
    id: 'route-waypoints',
    type: 'circle',
    source: SOURCE_IDS.routes,
    paint: {
      'circle-radius': 3.5,
      'circle-color': '#ffffff',
      'circle-stroke-color': '#1463ff',
      'circle-stroke-width': 1.5,
    },
  });
}

function addUnsupportedLayer(map) {
  // Unsupported pairs: portal endpoints + "no path" diagnostic; no line drawn.
  map.addLayer({
    id: 'route-unsupported',
    type: 'circle',
    source: SOURCE_IDS.unsupported,
    paint: {
      'circle-radius': 6,
      'circle-color': '#8a4baf',
      'circle-opacity': 0.85,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5,
    },
  });
}

function addLandExclusionLayer(map) {
  // hard_exclusion hazards rendered as solid exclusion areas.
  map.addLayer({
    id: 'land-exclusion',
    type: 'fill',
    source: SOURCE_IDS.hazards,
    filter: ['==', ['get', 'class'], 'hard_exclusion'],
    paint: {
      'fill-color': '#b3261e',
      'fill-opacity': 0.5,
    },
  });
  map.addLayer({
    id: 'land-exclusion-outline',
    type: 'line',
    source: SOURCE_IDS.hazards,
    filter: ['==', ['get', 'class'], 'hard_exclusion'],
    paint: {
      'line-color': '#8c1d16',
      'line-width': 2,
    },
  });
}

function addHazardsUncertaintyLayer(map) {
  // Non-hard hazard classes: clearance_exclusion (amber warning),
  // unknown_unverified (hatched/dashed), navigation_aid (neutral helper).
  map.addLayer({
    id: 'hazards-uncertainty',
    type: 'fill',
    source: SOURCE_IDS.hazards,
    filter: ['!=', ['get', 'class'], 'hard_exclusion'],
    paint: {
      'fill-color': [
        'match', ['get', 'class'],
        'clearance_exclusion', '#bd6b00',
        'unknown_unverified', '#9c6a00',
        'navigation_aid', '#5b7c99',
        '#888888',
      ],
      'fill-opacity': 0.35,
    },
  });
  map.addLayer({
    id: 'hazards-uncertainty-outline',
    type: 'line',
    source: SOURCE_IDS.hazards,
    filter: ['!=', ['get', 'class'], 'hard_exclusion'],
    paint: {
      'line-color': [
        'match', ['get', 'class'],
        'clearance_exclusion', '#bd6b00',
        'unknown_unverified', '#9c6a00',
        'navigation_aid', '#5b7c99',
        '#888888',
      ],
      'line-dasharray': [3, 2],
      'line-width': 2,
    },
  });
}

function addDestinationsLayer(map) {
  map.addLayer({
    id: 'destinations',
    type: 'circle',
    source: SOURCE_IDS.destinations,
    paint: {
      'circle-radius': 5,
      'circle-color': '#0a7d36',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5,
    },
  });
}

function addSeamarksLayer(map) {
  // Informational overlay only — NOT an official chart or routing authority.
  map.addLayer({
    id: 'seamarks',
    type: 'symbol',
    source: SOURCE_IDS.seamarks,
    layout: {
      'icon-image': ['coalesce', ['get', 'icon'], ''],
      'text-field': ['get', 'name'],
      'text-size': 11,
      'text-offset': [0, 1.2],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: {
      'text-color': '#17202a',
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.5,
    },
  });
}

// ---------------------------------------------------------------------------
// Leg/waypoint inspection. Shows ONLY sanitized #259 metadata plus bearing and
// per-leg distance derived geometrically from the existing coordinates.
// ---------------------------------------------------------------------------
function routeLegInfo(feature, startIdx) {
  const props = feature.properties;
  const coords = feature.geometry.coordinates;
  const a = coords[startIdx];
  const b = coords[startIdx + 1];
  const bearing = initialBearing(a, b);
  const distanceKm = haversineKm(a, b);
  return {
    pair_id: props.pair_id,
    src_id: props.src_id,
    dst_id: props.dst_id,
    state: props.state,
    reason: props.reason,
    distance_km: props.distance_km,
    distance_nm: props.distance_nm,
    waypoint_count: props.waypoint_count,
    validation_authority: props.validation_authority,
    leg_geometry: {
      bearing_deg: Number(bearing.toFixed(1)),
      distance_km: Number(distanceKm.toFixed(3)),
      from: [a[0], a[1]],
      to: [b[0], b[1]],
    },
  };
}

function waypointInfo(feature, idx) {
  const props = feature.properties;
  const coords = feature.geometry.coordinates;
  const point = coords[idx];
  const prev = idx > 0 ? coords[idx - 1] : null;
  const next = idx < coords.length - 1 ? coords[idx + 1] : null;
  const info = {
    pair_id: props.pair_id,
    src_id: props.src_id,
    dst_id: props.dst_id,
    state: props.state,
    waypoint_index: idx,
    waypoint_count: props.waypoint_count,
    coordinate: [point[0], point[1]],
  };
  if (prev) info.arrival_distance_km = Number(haversineKm(prev, point).toFixed(3));
  else info.arrival_distance_km = 0;
  if (next) info.bearing_to_next_deg = Number(
    initialBearing(point, next).toFixed(1));
  return info;
}

function formatInspectionRow(label, value) {
  const div = document.createElement('div');
  div.className = 'insp-row';
  const k = document.createElement('span');
  k.textContent = label;
  const v = document.createElement('strong');
  v.textContent = value;
  div.append(k, v);
  return div;
}

function showInspection(el, rows) {
  el.textContent = '';
  rows.forEach(([label, value]) => el.appendChild(formatInspectionRow(label, value)));
}

function addClickHandlers(map, bundle, inspectionEl) {
  // Supported route leg inspection.
  map.on('click', 'route-legs', (e) => {
    if (!e.features || !e.features.length) return;
    const feature = e.features[0];
    const props = feature.properties;
    const coords = feature.geometry.coordinates;
    // Find the nearest leg start index to the click point.
    const pt = e.lngLat.toArray();
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < coords.length - 1; i++) {
      const d = haversineKm(coords[i], pt);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    const info = routeLegInfo(feature, best);
    const rows = [
      ['Leg', `${props.pair_id} (${props.src_id} → ${props.dst_id})`],
      ['State', props.state],
      ['Reason', props.reason || '—'],
      ['Bearing', `${info.leg_geometry.bearing_deg}°`],
      ['This leg distance', `${info.leg_geometry.distance_km} km`],
      ['Total distance', formatKm(info.distance_km)],
      ['Waypoints', info.waypoint_count ?? '—'],
      ['Validation', props.validation_authority || 'geometrically validated planning data'],
    ];
    showInspection(inspectionEl, rows);
  });

  // Waypoint inspection.
  map.on('click', 'route-waypoints', (e) => {
    if (!e.features || !e.features.length) return;
    const feature = e.features[0];
    const coords = feature.geometry.coordinates;
    const pt = e.lngLat.toArray();
    let best = 0;
    let bestDist = Infinity;
    coords.forEach((c, i) => {
      const d = haversineKm(c, pt);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    const info = waypointInfo(feature, best);
    const rows = [
      ['Waypoint', `${info.pair_id} · index ${best}`],
      ['State', propsOf(feature).state],
      ['Position', ptToDMS(info.coordinate)],
      ['Arrival (last leg)', `${info.arrival_distance_km} km`],
      ...(info.bearing_to_next_deg != null
        ? [['Bearing to next', `${info.bearing_to_next_deg}°`]]
        : [['Bearing to next', '— (destination)']]),
    ];
    showInspection(inspectionEl, rows);
  });

  // Unsupported pair diagnostic.
  map.on('click', 'route-unsupported', (e) => {
    if (!e.features || !e.features.length) return;
    const props = e.features[0].properties;
    const rows = [
      ['Pair', `${props.src_id} → ${props.dst_id}`],
      ['Endpoint', props.endpointRole === 'src' ? 'Source portal' : 'Destination portal'],
      ['State', props.state],
      ['Status', 'Unsupported — no path'],
      ['Reason', props.reason || '—'],
      ['Path', 'No route is drawn: no path exists in the public bundle'],
    ];
    showInspection(inspectionEl, rows);
  });

  // Hazard inspection.
  map.on('click', ['land-exclusion', 'hazards-uncertainty'], (e) => {
    if (!e.features || !e.features.length) return;
    const props = e.features[0].properties;
    const rows = [
      ['Hazard', props.name],
      ['Class', props.class],
      ['Status', hazardStatusLabel(props.class)],
      ['Source', props.source_type || '—'],
      ['Licence', props.licence || '—'],
      ['Provenance', Array.isArray(props.provenance) ? props.provenance.join(', ') : '—'],
    ];
    showInspection(inspectionEl, rows);
  });

  // Destination inspection.
  map.on('click', 'destinations', (e) => {
    if (!e.features || !e.features.length) return;
    const d = e.features[0].properties;
    const rows = [
      ['Destination', d.name],
      ['Classification', d.classification],
      ['Display', ptToDMS(d.display_point)],
      ['Routing portal', ptToDMS(d.routing_portal)],
    ];
    showInspection(inspectionEl, rows);
  });
}

function hazardStatusLabel(cls) {
  switch (cls) {
    case 'hard_exclusion': return 'Hard exclusion — do not plan through';
    case 'clearance_exclusion': return 'Uncertainty — verify clearance';
    case 'unknown_unverified': return 'Uncertain — verify before planning';
    case 'navigation_aid': return 'Navigation aid (informational)';
    default: return cls;
  }
}

function propsOf(feature) { return feature.properties || {}; }

function ptToDMS(coord) {
  const [lon, lat] = coord;
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}°${ns}, ${Math.abs(lon).toFixed(4)}°${ew}`;
}

function formatKm(km) {
  if (typeof km !== 'number' || !Number.isFinite(km)) return 'supplied only via bundle';
  return `${km.toFixed(2)} km`;
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
function buildLayerToggles(container) {
  container.innerHTML = '';
  for (const layer of LAYER_REGISTRY) {
    const label = document.createElement('label');
    label.className = 'layer-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.layer = layer.id;
    input.checked = layer.defaultOn;
    label.appendChild(input);
    const span = document.createElement('span');
    span.textContent = layer.label;
    label.appendChild(span);
    container.appendChild(label);
  }
}

function bindToggles(map, container) {
  container.querySelectorAll('input[data-layer]').forEach((input) => {
    input.addEventListener('change', () => {
      map.setLayoutProperty(input.dataset.layer, 'visibility',
        input.checked ? 'visible' : 'none');
    });
  });
}

function applyDefaultVisibilities(map) {
  LAYER_REGISTRY.forEach((layer) => {
    map.setLayoutProperty(layer.id, 'visibility',
      layer.defaultOn ? 'visible' : 'none');
  });
}

function routeBounds(bundle) {
  const bounds = new maplibregl.LngLatBounds();
  bundle.routes.features.forEach((f) => {
    if (f.geometry) f.geometry.coordinates.forEach((c) => bounds.extend(c));
  });
  bundle.hazards.features.forEach((f) => {
    visitCoordinateArrays(f.geometry.coordinates, (c) => bounds.extend(c));
  });
  if (bounds.isEmpty()) bounds.extend([-2.4, 49.4]).extend([-1.5, 48.8]);
  return bounds;
}

async function loadBundle() {
  const [routesRes, destRes, hazRes, metaRes] = await Promise.all([
    fetch(CONFIG.bundle.routes, { cache: 'no-store' }),
    fetch(CONFIG.bundle.destinations, { cache: 'no-store' }),
    fetch(CONFIG.bundle.hazards, { cache: 'no-store' }),
    fetch(CONFIG.bundle.metadata, { cache: 'no-store' }),
  ]);
  const ok = [routesRes, destRes, hazRes, metaRes].every((r) => r.ok);
  if (!ok) throw new Error('One or more bundle files could not be fetched.');
  const bundle = {
    routes: await routesRes.json(),
    destinations: await destRes.json(),
    hazards: await hazRes.json(),
    metadata: await metaRes.json(),
  };
  return validateBundle(bundle);
}

async function start() {
  const errorBox = document.querySelector('#viewer-error');
  const inspectionEl = document.querySelector('#inspection-details');
  try {
    const bundle = await loadBundle();
    updateSummary(bundle.metadata, bundle);

    const map = new maplibregl.Map({
      container: 'map',
      style: CONFIG.basemap.styleUrl,
      center: [-1.95, 49.28],
      zoom: 8,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
    map.addControl(
      new maplibregl.AttributionControl({
        compact: false,
        customAttribution: CONFIG.basemap.attribution,
      }),
      'bottom-right',
    );

    map.on('load', () => {
      const seamarkFeatures = null; // optional feed; unset = empty but registered
      addSources(map, bundle, seamarkFeatures);
      addRouteLegsLayer(map);
      addRouteWaypointsLayer(map);
      addUnsupportedLayer(map);
      addLandExclusionLayer(map);
      addHazardsUncertaintyLayer(map);
      addDestinationsLayer(map);
      addSeamarksLayer(map);
      applyDefaultVisibilities(map);

      const togglePanel = document.querySelector('#layer-toggles');
      buildLayerToggles(togglePanel);
      bindToggles(map, togglePanel);

      addClickHandlers(map, bundle, inspectionEl);

      const mobile = window.matchMedia('(max-width: 700px)').matches;
      map.fitBounds(routeBounds(bundle), {
        padding: mobile ? 38 : 72,
        maxZoom: 11,
        duration: 0,
      });
    });
  } catch (error) {
    errorBox.hidden = false;
    errorBox.textContent = `Viewer could not load the planning bundle: ${error.message}`;
    console.error(error);
  }
}

function updateSummary(metadata, bundle) {
  const counts = metadata.counts || {};
  document.querySelector('#route-title').textContent = 'Channel Islands marine routes';
  document.querySelector('#route-subtitle').textContent = 'Planning inspection — public bundle #259';
  const supported = bundle.routes.features.filter(
    (f) => f.properties.state === 'supported').length;
  setMetric('#metric-routes', `${supported} planned`, `${counts.routes ?? '?'} pairs`);
  setMetric('#metric-waypoints', waypointTotal(bundle), 'waypoints');
  setMetric('#metric-hazards', `${counts.hazards ?? '?'}`, 'hazard zones');
  document.querySelector('#route-note').textContent =
    metadata.hazard_note || 'Planning output only.';
  const metaLine = document.querySelector('#metadata-line');
  metaLine.textContent = `Bundle: ${metadata.bundle_name ?? '—'} · generated by ` +
    `${metadata.generator ?? '—'} v${metadata.generator_version ?? '—'}. ` +
    `No live position or private data.`;
}

function setMetric(selector, val, sub) {
  const el = document.querySelector(selector);
  if (!el) return;
  el.querySelector('strong').textContent = val;
  const small = el.querySelector('span');
  if (sub) small.textContent = sub;
}

function waypointTotal(bundle) {
  let total = 0;
  bundle.routes.features.forEach((f) => {
    if (f.properties.state === 'supported' && f.geometry) {
      total += f.geometry.coordinates.length;
    }
  });
  return total;
}

// Auto-start the #260 viewer only when its own containers are present, so
// the module may be imported by the #290 weekend planner (to reuse
// validateBundle / haversineKm / initialBearing) without side-effects.
if (document.querySelector('#map') &&
    document.querySelector('#viewer-error') &&
    document.querySelector('#inspection-details')) {
  start();
}

