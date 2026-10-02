const App = {
  config: null,
  state: null,
  currentBasemap: 'voyager',
  trafficDisplayMode: 'full', // 'full' (all corridors & hubs) | 'bubbles' (circle hubs only) | 'focus'
  map: null,
  incidentMap: null,
  constructionMap: null,
  baseLayers: {},
  groups: {
    sectorBubbles: null,
    corridors: null,
    blackspots: null,
    cameras: null,
    vms: null,
    patrols: null,
    events: null,
    landmarks: null,
    greenCorridor: null,
  },
  corridorLayers: {}, // zone -> { casing, core, flow, data }
  sectorBubbleMarkers: {}, // zone -> marker
  selectedZone: null,
  cctvAnimationId: null,
  activeCamera: null,
  charts: {},
  greenCorridor: null,
  greenCorridorLayers: {},
  greenCorridorTimer: null,
  greenCorridorAnim: null,
};

const qs = (s, root = document) => root.querySelector(s);
const qsa = (s, root = document) => [...root.querySelectorAll(s)];

const DEFAULT_MAP_API_KEY = 'cb1_45s7_1_3d829709b69d55e1cf7f0aad';

function toast(message) {
  const el = qs('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function api(url, options = {}) {
  return fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  }).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  });
}

function densityColor(level) {
  return {
    Free: '#10b981',
    Moderate: '#f59e0b',
    Heavy: '#f97316',
    Severe: '#ef4444',
  }[level] || '#f59e0b';
}

function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function updateClock() {
  const d = new Date();
  const timeEl = qs('#clockTime');
  const dateEl = qs('#clockDate');
  if (timeEl) timeEl.textContent = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (dateEl) dateEl.textContent = d.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) + ' · IST';
}

function setView(view) {
  qsa('.nav-tab, .nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  qsa('.view').forEach(v => v.classList.remove('active'));
  const targetView = qs(`#view-${view}`);
  if (targetView) targetView.classList.add('active');

  const titleEl = qs('#pageTitle');
  if (titleEl) {
    const titles = {
      operations: 'Live Operations & Road Network',
      blackspots: 'Accident Prone Blackspots & Danger Zones',
      cctv: 'CCTV Surveillance & ANPR Video Wall',
      dispatch: 'Patrol Units & Field Deployment',
      forecast: 'Predictive Analytics & Trajectory Model',
      incidents: 'Field Incident Desk & Reports',
      construction: 'Work Zone Registry & Advisories',
      analytics: 'Traffic Audit & Performance Matrix',
    };
    titleEl.textContent = titles[view] || 'Worli Traffic Intelligence';
  }

  setTimeout(() => {
    if (view === 'operations') App.map?.invalidateSize();
    if (view === 'incidents') App.incidentMap?.invalidateSize();
    if (view === 'construction') App.constructionMap?.invalidateSize();
  }, 100);

  if (view === 'blackspots') renderBlackspotsView();
  if (view === 'cctv') renderCctvWall();
  if (view === 'dispatch') renderDispatchView();
  if (view === 'forecast') loadForecast();
  if (view === 'incidents') loadIncidentTable();
  if (view === 'construction') loadConstructionTable();
  if (view === 'analytics') renderAnalytics();
}

// ================= BASEMAP PROVIDERS =================
function createTileLayers(apiKey) {
  const key = apiKey || App.config?.map_api_key || DEFAULT_MAP_API_KEY;
  const keyParam = key ? `?key=${encodeURIComponent(key)}&v=2` : '';

  return {
    voyager: L.tileLayer(`https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png${keyParam}`, {
      maxZoom: 19,
      subdomains: 'abcd',
      attribution: '&copy; CARTO &copy; OpenStreetMap contributors',
    }),
    dark: L.tileLayer(`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png${keyParam}`, {
      maxZoom: 19,
      subdomains: 'abcd',
      attribution: '&copy; CARTO &copy; OpenStreetMap contributors',
    }),
    satellite: L.layerGroup([
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri',
      }),
      L.tileLayer(`https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png${keyParam}`, {
        maxZoom: 19,
        subdomains: 'abcd',
      }),
    ]),
    osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }),
  };
}

function switchBasemap(style) {
  if (!App.map || !App.baseLayers[style] || App.currentBasemap === style) return;
  App.map.removeLayer(App.baseLayers[App.currentBasemap]);
  App.baseLayers[style].addTo(App.map);
  App.currentBasemap = style;

  qsa('.style-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.style === style);
  });
}

function initMaps() {
  const center = App.config.center || [19.0065, 72.8185];
  const zoom = App.config.zoom || 14;

  App.baseLayers = createTileLayers();

  // 1. Operations Map
  App.map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
  }).setView(center, zoom);

  App.baseLayers.voyager.addTo(App.map);

  // Initialize Layer Groups
  App.groups.sectorBubbles = L.layerGroup().addTo(App.map);
  App.groups.corridors = L.layerGroup().addTo(App.map);
  App.groups.blackspots = L.layerGroup().addTo(App.map);
  App.groups.cameras = L.layerGroup().addTo(App.map);
  App.groups.vms = L.layerGroup().addTo(App.map);
  App.groups.patrols = L.layerGroup().addTo(App.map);
  App.groups.events = L.layerGroup().addTo(App.map);
  App.groups.landmarks = L.layerGroup().addTo(App.map);
  App.groups.greenCorridor = L.layerGroup().addTo(App.map);

  // Map events
  App.map.on('mousemove', e => {
    qs('#hudCoords').textContent = `${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`;
  });
  App.map.on('zoomend', () => {
    qs('#hudZoom').textContent = App.map.getZoom();
  });
  App.map.on('click', e => {
    if (!App.pickMode && App.selectedZone) {
      deselectCorridor();
    }
  });

  // 2. Incident Picker Map
  App.incidentMap = L.map('incidentMap', { zoomControl: true }).setView(center, zoom);
  createTileLayers().voyager.addTo(App.incidentMap);
  App.incidentMap.on('click', e => handleMapPick('incident', e.latlng));

  // 3. Construction Picker Map
  App.constructionMap = L.map('constructionMap', { zoomControl: true }).setView(center, zoom);
  createTileLayers().voyager.addTo(App.constructionMap);
  App.constructionMap.on('click', e => handleMapPick('construction', e.latlng));

  renderLandmarks();
}

function landmarkIcon(category, name) {
  const icons = {
    junction: '✛',
    toll: '⛊',
    landmark: '◈',
    interchange: '☍',
    cultural: '✦',
    medical: '✚',
    commercial: '🏢',
    heritage: '⚓',
  };
  const icon = icons[category] || '📍';
  return L.divIcon({
    className: '',
    html: `<div class="landmark-badge" title="${name}"><span class="landmark-icon">${icon}</span><span>${name}</span></div>`,
    iconSize: [null, 24],
    iconAnchor: [20, 12],
  });
}

function renderLandmarks() {
  if (!App.config?.landmarks) return;
  App.groups.landmarks.clearLayers();
  App.config.landmarks.forEach(lm => {
    const marker = L.marker(lm.coords, { icon: landmarkIcon(lm.category, lm.name) });
    marker.bindPopup(`
      <div class="map-popup">
        <h4>${lm.name}</h4>
        <p>${lm.desc}</p>
        <div class="popup-stat-grid">
          <div class="popup-stat">Category: <b>${lm.category.toUpperCase()}</b></div>
          <div class="popup-stat">Coords: <b>${lm.coords[0].toFixed(4)}, ${lm.coords[1].toFixed(4)}</b></div>
        </div>
      </div>
    `);
    App.groups.landmarks.addLayer(marker);
  });
}

// ================= CIRCLE SECTOR BUBBLES & CORRIDORS =================
function renderNetworkLayers() {
  App.groups.sectorBubbles.clearLayers();
  App.groups.corridors.clearLayers();
  App.corridorLayers = {};
  App.sectorBubbleMarkers = {};

  if (!App.state?.predictions) return;

  App.state.predictions.forEach(p => {
    const color = densityColor(p.level);
    const centroid = p.centroid || p.coords[Math.floor(p.coords.length / 2)];

    // 1. Geometric Circle Hub Zone (High-tech road junction catchment circle)
    const hubCircle = L.circle(centroid, {
      radius: 180,
      color: color,
      fillColor: color,
      fillOpacity: 0.20,
      weight: 2,
      dashArray: '5, 8',
    });

    // 2. High-Visibility Circle Hub Badge Marker
    const bubbleIcon = L.divIcon({
      className: 'circle-hub-div-icon',
      html: `
        <div class="sector-bubble-marker" data-zone="${p.zone}" title="${p.zone} Circle Hub · ${p.level} (${p.density}%)">
          <div class="bubble-pulse-ring" style="border-color:${color}; background:${color}26;"></div>
          <div class="bubble-badge" style="border-color:${color}; box-shadow: 0 4px 18px ${color}55;">
            <span class="bubble-hub-dot" style="background:${color};"></span>
            <span class="bubble-code">${p.zone_code || p.zone.slice(0, 3).toUpperCase()}</span>
            <span class="bubble-stats" style="color:${color};">${p.density}% · ${p.avg_speed_kmph}k</span>
          </div>
        </div>
      `,
      iconSize: [120, 36],
      iconAnchor: [60, 18],
    });

    const bubbleMarker = L.marker(centroid, { icon: bubbleIcon, zIndexOffset: 250 });

    // Interactive events on Circle Hub
    const onHubClick = () => selectCorridor(p.zone);
    const onHubOver = () => {
      hubCircle.setStyle({ fillOpacity: 0.38, weight: 3 });
      if (App.trafficDisplayMode !== 'full' && App.selectedZone !== p.zone) {
        showCorridorPolyline(p.zone, false);
      }
      showInspector(p);
    };
    const onHubOut = () => {
      hubCircle.setStyle({ fillOpacity: 0.20, weight: 2 });
      if (App.trafficDisplayMode !== 'full' && App.selectedZone !== p.zone) {
        hideCorridorPolyline(p.zone);
      }
      if (!App.selectedZone) hideInspector();
    };

    bubbleMarker.on('click', onHubClick);
    bubbleMarker.on('mouseover', onHubOver);
    bubbleMarker.on('mouseout', onHubOut);

    hubCircle.on('click', onHubClick);
    hubCircle.on('mouseover', onHubOver);
    hubCircle.on('mouseout', onHubOut);

    App.groups.sectorBubbles.addLayer(hubCircle);
    App.groups.sectorBubbles.addLayer(bubbleMarker);
    App.sectorBubbleMarkers[p.zone] = bubbleMarker;

    // 3. Detailed Real-World Corridor Polyline Layers
    const casing = L.polyline(p.coords, {
      color: '#070a12',
      weight: 10,
      opacity: 0.82,
      lineCap: 'round',
      lineJoin: 'round',
    });

    const core = L.polyline(p.coords, {
      color: color,
      weight: 5.5,
      opacity: 0.95,
      lineCap: 'round',
      lineJoin: 'round',
    });

    const flow = L.polyline(p.coords, {
      className: 'leaflet-flow-path',
      color: '#ffffff',
      weight: 2,
      opacity: 0.85,
      dashArray: '8, 14',
      lineCap: 'round',
    });

    const group = L.featureGroup([casing, core, flow]);

    group.on('mouseover', () => {
      core.setStyle({ weight: 9, opacity: 1 });
      casing.setStyle({ weight: 14, opacity: 0.9 });
      hubCircle.setStyle({ fillOpacity: 0.40, weight: 3 });
      showInspector(p);
    });
    group.on('mouseout', () => {
      if (App.selectedZone !== p.zone) {
        core.setStyle({ weight: 5.5, opacity: 0.95 });
        casing.setStyle({ weight: 10, opacity: 0.82 });
        hubCircle.setStyle({ fillOpacity: 0.20, weight: 2 });
        if (!App.selectedZone) hideInspector();
      }
    });
    group.on('click', () => selectCorridor(p.zone));

    App.corridorLayers[p.zone] = { casing, core, flow, group, hubCircle, data: p };

    // If display mode is 'full', immediately add all corridor lines to map
    if (App.trafficDisplayMode === 'full') {
      App.groups.corridors.addLayer(casing);
      App.groups.corridors.addLayer(core);
      App.groups.corridors.addLayer(flow);
    }
  });

  // Re-highlight selected zone if active
  if (App.selectedZone && App.corridorLayers[App.selectedZone]) {
    showCorridorPolyline(App.selectedZone, true);
  }
}

function showCorridorPolyline(zoneName, isSelected = false) {
  const item = App.corridorLayers[zoneName];
  if (!item) return;

  if (!App.groups.corridors.hasLayer(item.casing)) {
    App.groups.corridors.addLayer(item.casing);
    App.groups.corridors.addLayer(item.core);
    App.groups.corridors.addLayer(item.flow);
  }

  if (isSelected) {
    item.core.setStyle({ weight: 10, opacity: 1 });
    item.casing.setStyle({ weight: 16, opacity: 0.9 });
    if (item.hubCircle) item.hubCircle.setStyle({ fillOpacity: 0.45, weight: 3.5 });
  } else {
    item.core.setStyle({ weight: 6, opacity: 0.95 });
    item.casing.setStyle({ weight: 11, opacity: 0.82 });
    if (item.hubCircle) item.hubCircle.setStyle({ fillOpacity: 0.22, weight: 2 });
  }
}

function hideCorridorPolyline(zoneName) {
  const item = App.corridorLayers[zoneName];
  if (!item) return;

  // Don't remove if display mode is 'full'
  if (App.trafficDisplayMode !== 'full') {
    App.groups.corridors.removeLayer(item.casing);
    App.groups.corridors.removeLayer(item.core);
    App.groups.corridors.removeLayer(item.flow);
  } else {
    item.core.setStyle({ weight: 5.5, opacity: 0.95 });
    item.casing.setStyle({ weight: 10, opacity: 0.82 });
    if (item.hubCircle) item.hubCircle.setStyle({ fillOpacity: 0.20, weight: 2 });
  }
}

function setTrafficDisplayMode(mode) {
  App.trafficDisplayMode = mode;
  qsa('.mode-pill').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));

  const hudMode = qs('#hudMode');
  if (hudMode) {
    hudMode.textContent = mode === 'full' ? 'All Corridors & Hubs' : mode === 'bubbles' ? 'Circle Hubs Only' : 'Focus on Click';
  }

  const hubsCheck = qs('#layerHubs');
  const corridorsCheck = qs('#layerCorridors');

  if (mode === 'bubbles') {
    App.map.addLayer(App.groups.sectorBubbles);
    if (hubsCheck) hubsCheck.checked = true;
    if (corridorsCheck) corridorsCheck.checked = false;
    // Clear all lines except selected
    App.groups.corridors.clearLayers();
    if (App.selectedZone) showCorridorPolyline(App.selectedZone, true);
  } else if (mode === 'focus') {
    App.map.removeLayer(App.groups.sectorBubbles);
    if (hubsCheck) hubsCheck.checked = false;
    if (corridorsCheck) corridorsCheck.checked = false;
    App.groups.corridors.clearLayers();
    if (App.selectedZone) showCorridorPolyline(App.selectedZone, true);
  } else if (mode === 'full') {
    App.map.addLayer(App.groups.sectorBubbles);
    App.map.addLayer(App.groups.corridors);
    if (hubsCheck) hubsCheck.checked = true;
    if (corridorsCheck) corridorsCheck.checked = true;
    // Add all corridor lines
    Object.keys(App.corridorLayers).forEach(z => showCorridorPolyline(z, z === App.selectedZone));
  }
}

function selectCorridor(zoneName) {
  const item = App.corridorLayers[zoneName];
  if (!item) return;

  // Deselect previous
  if (App.selectedZone && App.selectedZone !== zoneName) {
    hideCorridorPolyline(App.selectedZone);
  }

  App.selectedZone = zoneName;
  showCorridorPolyline(zoneName, true);

  App.map.flyToBounds(item.core.getBounds(), {
    padding: [70, 70],
    duration: 0.8,
    maxZoom: 16,
  });

  showInspector(item.data);

  qsa('.zone-card').forEach(c => {
    c.classList.toggle('selected', c.dataset.zone === zoneName);
    if (c.dataset.zone === zoneName) {
      c.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
}

function deselectCorridor() {
  if (App.selectedZone) {
    hideCorridorPolyline(App.selectedZone);
    App.selectedZone = null;
  }
  qsa('.zone-card').forEach(c => c.classList.remove('selected'));
  hideInspector();
}

function showInspector(p) {
  const el = qs('#corridorInspector');
  if (!el) return;

  qs('#inspName').textContent = p.zone;
  qs('#inspDesc').textContent = p.description || 'Monitored Worli Corridor';
  qs('#inspLevel').textContent = p.level;
  qs('#inspLevel').className = `inspector-badge zone-status ${p.level}`;
  qs('#inspDensity').textContent = `${p.density}%`;
  qs('#inspSpeed').textContent = `${p.avg_speed_kmph} km/h`;
  qs('#inspLimit').textContent = `${p.speed_limit} km/h`;
  qs('#inspTravel').textContent = `${p.travel_time_minutes} min`;
  qs('#inspDelay').textContent = p.delay_minutes > 0 ? `+${p.delay_minutes} min` : 'Normal';
  qs('#inspDelay').style.color = p.delay_minutes > 3 ? '#ef4444' : '#10b981';
  qs('#inspLength').textContent = `${p.length_km} km`;
  qs('#inspLanes').textContent = `Configured Lanes (${p.lanes.length}): ${p.lanes.join(', ')}`;

  // Wire buttons
  const dispatchBtn = qs('#inspDispatchBtn');
  if (dispatchBtn) {
    dispatchBtn.onclick = () => quickDispatch(p.zone);
  }
  const viewCamBtn = qs('#inspViewCamBtn');
  if (viewCamBtn) {
    viewCamBtn.onclick = () => openNearestCctv(p.centroid || p.coords[0]);
  }

  el.classList.add('show');
}

function hideInspector() {
  const el = qs('#corridorInspector');
  if (el) el.classList.remove('show');
}

// ================= ACCIDENT BLACKSPOTS (HIGH VISIBILITY INTELLIGENCE) =================
function renderBlackspotsLayer() {
  App.groups.blackspots.clearLayers();
  if (!App.config?.accident_blackspots) return;

  App.config.accident_blackspots.forEach(bs => {
    const riskColor = bs.risk_level === 'critical' ? '#ef4444' : bs.risk_level === 'high' ? '#f97316' : '#f59e0b';

    // 1. Warning Circle Zone with animated dashed hazard ring
    const circle = L.circle(bs.coords, {
      radius: bs.radius_meters || 140,
      color: riskColor,
      fillColor: riskColor,
      fillOpacity: 0.18,
      weight: 2.5,
      dashArray: '8, 6',
    });

    // 2. High-Visibility Beacon & ID Pin Icon
    const icon = L.divIcon({
      className: '',
      html: `
        <div class="marker-blackspot" title="${bs.name} (${bs.id})">
          <div class="blackspot-beacon" style="background:${riskColor}40; box-shadow: 0 0 24px ${riskColor};"></div>
          <div class="blackspot-pin" style="border-color:${riskColor};">
            <span style="font-size:12px;">⚠️</span>
            <span>${bs.id}</span>
          </div>
        </div>
      `,
      iconSize: [52, 28],
      iconAnchor: [26, 14],
    });

    const marker = L.marker(bs.coords, { icon, zIndexOffset: 300 });

    // 3. Rich Tactical Leaflet Popup
    const popupHtml = `
      <div class="blackspot-tactical-popup ${bs.risk_level}">
        <div class="bs-popup-hazard-bar"></div>
        <div class="bs-popup-header">
          <div class="bs-popup-badge ${bs.risk_level}">
            <span>⚠️ ${bs.id}</span>
            <span>·</span>
            <span>${bs.risk_level.toUpperCase()} HAZARD</span>
          </div>
          <span class="bs-popup-collisions">${bs.collision_count_ytd} Incidents</span>
        </div>
        <h4 class="bs-popup-title">${bs.name}</h4>
        <div class="bs-popup-meta">
          <span>Sector: <b>${bs.zone}</b></span>
          <span>Speed Limit: <b>${bs.speed_limit} km/h</b></span>
        </div>
        <div class="bs-popup-factors">
          <div class="bs-factors-label">ROADWAY RISK FACTORS:</div>
          <ul>${bs.hazard_factors.slice(0, 3).map(f => `<li>${f}</li>`).join('')}</ul>
        </div>
        <div class="bs-popup-advisory">
          <span style="font-size:13px;">🛡️</span>
          <span>${bs.advisory}</span>
        </div>
        <div class="bs-popup-actions">
          <button type="button" class="btn small primary" onclick="quickDispatch('${bs.name}')">🚨 Dispatch</button>
          <button type="button" class="btn small secondary" onclick="showBlackspotModalFromMap('${bs.id}')">📋 Full Dossier</button>
        </div>
      </div>
    `;

    marker.bindPopup(popupHtml, {
      className: 'leaflet-tactical-blackspot-popup',
      maxWidth: 325,
      minWidth: 290,
      autoPanPadding: [50, 50],
    });

    circle.bindPopup(popupHtml, {
      className: 'leaflet-tactical-blackspot-popup',
      maxWidth: 325,
      minWidth: 290,
    });

    App.groups.blackspots.addLayer(circle);
    App.groups.blackspots.addLayer(marker);
  });
}

function showBlackspotModal(bs) {
  qs('#bsModalTitle').textContent = bs.name;
  qs('#bsModalRisk').textContent = `${bs.risk_level.toUpperCase()} RISK BLACKSPOT`;
  qs('#bsModalRisk').className = `kpi-chip ${bs.risk_level === 'critical' ? 'danger' : 'warning'}`;
  qs('#bsModalId').textContent = bs.id;
  qs('#bsModalCount').textContent = `${bs.collision_count_ytd} Reported`;
  qs('#bsModalLimit').textContent = `${bs.speed_limit} km/h`;
  qs('#bsModalFactors').innerHTML = bs.hazard_factors.map(f => `<li><b style="color:var(--amber-bright);margin-right:6px;">▸</b>${f}</li>`).join('');
  qs('#bsModalAdvisory').textContent = bs.advisory;

  qs('#bsDispatchBtn').onclick = () => {
    qs('#blackspotModal').classList.remove('show');
    quickDispatch(bs.name);
  };
  qs('#bsFocusMapBtn').onclick = () => {
    qs('#blackspotModal').classList.remove('show');
    App.map.flyTo(bs.coords, 16, { duration: 0.8 });
  };
  const closeBtn1 = qs('#closeBsModal');
  if (closeBtn1) closeBtn1.onclick = () => qs('#blackspotModal').classList.remove('show');
  const closeBtn2 = qs('#bsCloseModalBtn');
  if (closeBtn2) closeBtn2.onclick = () => qs('#blackspotModal').classList.remove('show');

  qs('#blackspotModal').classList.add('show');
}

function showBlackspotModalFromMap(id) {
  const bs = App.config?.accident_blackspots?.find(b => b.id === id);
  if (bs) {
    App.map.closePopup();
    showBlackspotModal(bs);
  }
}

function renderBlackspotsView() {
  const container = qs('#blackspotGrid');
  if (!container || !App.config?.accident_blackspots) return;

  container.innerHTML = App.config.accident_blackspots.map(bs => `
    <article class="blackspot-card ${bs.risk_level}">
      <div class="bs-top">
        <span class="bs-id">${bs.id} · ${bs.zone}</span>
        <span class="kpi-chip ${bs.risk_level === 'critical' ? 'danger' : 'warning'}">${bs.risk_level.toUpperCase()}</span>
      </div>
      <h3>${bs.name}</h3>
      <div class="bs-stat-row"><span>Collisions YTD:</span><strong>${bs.collision_count_ytd} Reported</strong></div>
      <div class="bs-stat-row"><span>Speed Limit:</span><strong>${bs.speed_limit} km/h</strong></div>
      <div class="bs-hazards">
        <strong>Hazard Risk Factors:</strong>
        <ul>${bs.hazard_factors.map(f => `<li>${f}</li>`).join('')}</ul>
      </div>
      <div class="bs-advisory">🛡️ ${bs.advisory}</div>
      <div class="action-group">
        <button class="btn small primary" onclick="quickDispatch('${bs.name}')">🚨 Dispatch</button>
        <button class="btn small secondary" onclick="locateCoords(${bs.coords[0]}, ${bs.coords[1]}, '${bs.name}')">⌖ View Map</button>
        <button class="btn small ghost" onclick="showBlackspotModalFromMap('${bs.id}')">Dossier</button>
      </div>
    </article>
  `).join('');
}

// ================= EMERGENCY GREEN CORRIDOR & VIP PROTOCOL =================
function playTacticalChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    
    // Multi-tone tactical green wave signal preemption alert
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now); // D5
    gain1.gain.setValueAtTime(0.12, now);
    gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.16);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.16);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(880, now + 0.12); // A5
    gain2.gain.setValueAtTime(0.18, now + 0.12);
    gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.42);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.12);
    osc2.stop(now + 0.42);
  } catch (e) {
    // Graceful fallback if audio blocked
  }
}

function openGreenCorridorModal() {
  updateGreenCorridorPreview();
  qs('#greenCorridorModal')?.classList.add('show');
}

function closeGreenCorridorModal() {
  qs('#greenCorridorModal')?.classList.remove('show');
}

function updateGreenCorridorPreview() {
  const origin = qs('#gcOrigin')?.value || 'Podar Hospital & SASMIRA';
  const dest = qs('#gcDestination')?.value || 'Bandra-Worli Sea Link Toll';
  const speed = parseInt(qs('#gcSpeed')?.value || '65', 10);
  
  if (qs('#gcSpeedVal')) qs('#gcSpeedVal').textContent = `${speed} km/h`;

  let dist = 4.5;
  let stdTime = 14.2;
  let routeName = `${origin} ➔ Worli Sea Face ➔ ${dest}`;

  if (dest.includes('Coastal Road')) {
    dist = 3.2;
    stdTime = 11.5;
    routeName = `${origin} ➔ Dr E Moses ➔ Coastal Tunnel Link`;
  } else if (origin.includes('Haji Ali')) {
    dist = 5.8;
    stdTime = 18.0;
    routeName = `${origin} ➔ Sea Face Spine ➔ ${dest}`;
  } else if (dest.includes('Century Bazaar') || dest.includes('Siddhivinayak')) {
    dist = 2.8;
    stdTime = 10.0;
    routeName = `${origin} ➔ Annie Besant North ➔ ${dest}`;
  }

  const greenTime = (dist / Math.max(20, speed)) * 60;
  const saved = Math.max(0, stdTime - greenTime);

  if (qs('#gcPreviewRoute')) qs('#gcPreviewRoute').textContent = routeName;
  if (qs('#gcPreviewDist')) qs('#gcPreviewDist').textContent = `Distance: ${dist.toFixed(1)} km · Target Speed: ${speed} km/h`;
  if (qs('#gcPreviewOldTime')) qs('#gcPreviewOldTime').textContent = `~${stdTime.toFixed(1)}m Normal`;
  if (qs('#gcPreviewNewTime')) qs('#gcPreviewNewTime').textContent = `⚡ ${greenTime.toFixed(1)}m Express`;
  if (qs('#gcPreviewSaved')) qs('#gcPreviewSaved').textContent = `Saves ~${saved.toFixed(1)} mins`;
}

async function handleGreenCorridorSubmit(e) {
  e.preventDefault();
  const payload = {
    mission_type: qs('#gcMissionType')?.value,
    vehicle_callsign: qs('#gcCallsign')?.value,
    origin: qs('#gcOrigin')?.value,
    destination: qs('#gcDestination')?.value,
    escort_unit: qs('#gcEscort')?.value,
    target_speed: parseInt(qs('#gcSpeed')?.value || '65', 10),
  };

  try {
    const res = await api('/api/green-corridor/activate', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    closeGreenCorridorModal();
    renderGreenCorridor(res.green_corridor);
    playTacticalChime();
    toast(`🚨 GREEN CORRIDOR ACTIVE: ${res.green_corridor.route_name}`);
    await loadState();
  } catch (err) {
    toast(`Failed to activate: ${err.message}`);
  }
}

function renderGreenCorridor(gc) {
  clearGreenCorridorLayers();
  App.greenCorridor = gc;

  // 1. Double-cased glowing emerald polyline
  const casing = L.polyline(gc.coords, {
    color: '#022c22',
    weight: 14,
    opacity: 0.92,
    lineCap: 'round',
    lineJoin: 'round',
  });

  const core = L.polyline(gc.coords, {
    color: '#10b981',
    weight: 7,
    opacity: 0.98,
    lineCap: 'round',
    lineJoin: 'round',
  });

  const flow = L.polyline(gc.coords, {
    className: 'leaflet-green-corridor-flow',
    color: '#ffffff',
    weight: 3.5,
    opacity: 0.95,
    dashArray: '8, 14',
    lineCap: 'round',
  });

  App.groups.greenCorridor.addLayer(casing);
  App.groups.greenCorridor.addLayer(core);
  App.groups.greenCorridor.addLayer(flow);

  // 2. Coordinated Green Wave Traffic Signal Badges
  (gc.signals || []).forEach(sig => {
    const icon = L.divIcon({
      className: '',
      html: `
        <div class="green-wave-signal-badge" title="${sig.name} · SCADA GREEN HELD">
          <span>🟢</span>
          <span>${sig.id} · GREEN HELD</span>
        </div>
      `,
      iconSize: [130, 24],
      iconAnchor: [65, 12],
    });
    const marker = L.marker(sig.coords, { icon, zIndexOffset: 350 });
    marker.bindPopup(`
      <div class="map-popup">
        <span class="kpi-chip green">SCADA GREEN WAVE PREEMPTION</span>
        <h4>${sig.name}</h4>
        <p>Traffic light cycle locked to <b>100% GREEN</b> for corridor transit.</p>
        <div class="popup-stat-grid">
          <div class="popup-stat">Hold Duration: <b>${sig.phase_sec}s</b></div>
          <div class="popup-stat">Conflict Red: <b>ALL CROSSINGS</b></div>
        </div>
      </div>
    `);
    App.groups.greenCorridor.addLayer(marker);
  });

  // 3. Dynamic Moving Ambulance Marker
  const ambIcon = L.divIcon({
    className: '',
    html: `
      <div class="ambulance-marker-pin" title="${gc.callsign} (${gc.mission_type})">
        <div class="ambulance-beacon-ring"></div>
        <div class="ambulance-badge">
          <span>🚑</span>
          <span>${gc.callsign}</span>
        </div>
      </div>
    `,
    iconSize: [110, 32],
    iconAnchor: [55, 16],
  });

  const ambMarker = L.marker(gc.coords[0], { icon: ambIcon, zIndexOffset: 450 });
  App.groups.greenCorridor.addLayer(ambMarker);
  App.greenCorridorLayers.vehicleMarker = ambMarker;

  // Animate moving vehicle along the route
  let step = 0;
  const totalSteps = gc.coords.length;
  clearInterval(App.greenCorridorAnim);
  App.greenCorridorAnim = setInterval(() => {
    step = (step + 1) % totalSteps;
    ambMarker.setLatLng(gc.coords[step]);
  }, 900);

  // 4. Update HUD
  const hud = qs('#greenCorridorHud');
  if (hud) {
    hud.classList.add('show');
    if (qs('#gcHudRoute')) qs('#gcHudRoute').textContent = `${gc.origin} ➔ ${gc.destination}`;
    if (qs('#gcHudSpeed')) qs('#gcHudSpeed').textContent = `${gc.speed_kmph} km/h`;
    if (qs('#gcHudSignals')) qs('#gcHudSignals').textContent = `${gc.signals.length}/${gc.signals.length} GREEN`;
    if (qs('#gcHudEscort')) qs('#gcHudEscort').textContent = gc.escort_unit;

    // Countdown timer
    let totalSeconds = Math.round(gc.green_wave_time_min * 60);
    clearInterval(App.greenCorridorTimer);
    const updateCountdown = () => {
      const m = Math.floor(totalSeconds / 60);
      const s = totalSeconds % 60;
      if (qs('#gcHudEta')) qs('#gcHudEta').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      if (totalSeconds > 0) totalSeconds--;
    };
    updateCountdown();
    App.greenCorridorTimer = setInterval(updateCountdown, 1000);
  }

  // Fly to fit the entire corridor
  App.map.flyToBounds(casing.getBounds(), { padding: [80, 80], duration: 1.0, maxZoom: 16 });
}

function clearGreenCorridorLayers() {
  if (App.groups.greenCorridor) App.groups.greenCorridor.clearLayers();
  clearInterval(App.greenCorridorAnim);
  clearInterval(App.greenCorridorTimer);
  App.greenCorridorAnim = null;
  App.greenCorridorTimer = null;
  App.greenCorridor = null;
  const hud = qs('#greenCorridorHud');
  if (hud) hud.classList.remove('show');
}

async function deactivateGreenCorridor() {
  try {
    await api('/api/green-corridor/deactivate', { method: 'POST' });
    clearGreenCorridorLayers();
    toast('🛑 Green Corridor stood down. Standard SCADA signals restored.');
    await loadState();
  } catch (err) {
    toast(`Error: ${err.message}`);
  }
}

// ================= CCTV CAMERAS & VIDEO SIMULATOR =================
function renderCctvLayer() {
  App.groups.cameras.clearLayers();
  if (!App.config?.cctv_cameras) return;

  App.config.cctv_cameras.forEach(cam => {
    const icon = L.divIcon({
      className: '',
      html: `<div class="marker-camera"><div class="camera-badge"><span>📹</span><span>${cam.id}</span></div></div>`,
      iconSize: [44, 22],
      iconAnchor: [22, 11],
    });
    const marker = L.marker(cam.coords, { icon, zIndexOffset: 250 });
    marker.on('click', () => openCctvStream(cam));
    App.groups.cameras.addLayer(marker);
  });
}

function openCctvStream(cam) {
  App.activeCamera = cam;
  qs('#modalCamTitle').textContent = `${cam.name} (${cam.id})`;
  qs('#modalCamRes').textContent = cam.resolution;
  qs('#modalCamCount').textContent = cam.vehicle_count_min;
  qs('#modalCamViolations').textContent = `${cam.speed_violations_today} Today`;
  qs('#cctvOsdId').textContent = `${cam.id} · ${cam.direction}`;
  qs('#cctvOsdZone').textContent = `SECTOR: ${cam.zone.toUpperCase()}`;

  startCctvSimulation();
  qs('#cctvModal').classList.add('show');
}

function startCctvSimulation() {
  const canvas = qs('#cctvCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  if (App.cctvAnimationId) cancelAnimationFrame(App.cctvAnimationId);

  // Simulated traffic vehicles
  const vehicles = [
    { x: 50, y: 180, speed: 2.2, type: 'CAR', id: '#MH-01-4421', speedKmph: 42, length: 40, width: 20, color: '#38bdf8' },
    { x: 220, y: 195, speed: 1.8, type: 'BEST BUS', id: '#MH-01-9014', speedKmph: 28, length: 65, width: 24, color: '#f59e0b' },
    { x: 380, y: 175, speed: 2.5, type: 'TAXI', id: '#MH-01-1189', speedKmph: 46, length: 38, width: 19, color: '#10b981' },
    { x: 520, y: 210, speed: 3.1, type: 'CAR', id: '#MH-02-8877', speedKmph: 62, length: 42, width: 20, color: '#ef4444' }, // speeding!
  ];

  function draw() {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Road tarmac
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, 140, canvas.width, 140);

    // Lane markings
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 2;
    ctx.setLineDash([15, 15]);
    ctx.beginPath();
    ctx.moveTo(0, 185); ctx.lineTo(canvas.width, 185);
    ctx.moveTo(0, 235); ctx.lineTo(canvas.width, 235);
    ctx.stroke();
    ctx.setLineDash([]);

    // Curbs & coastline
    ctx.fillStyle = '#0284c7';
    ctx.fillRect(0, 0, canvas.width, 120);

    // Update & draw vehicles
    vehicles.forEach(v => {
      v.x += v.speed;
      if (v.x > canvas.width + 50) v.x = -80;

      // Vehicle body
      ctx.fillStyle = '#334155';
      ctx.fillRect(v.x, v.y, v.length, v.width);

      // AI Bounding Box & ANPR Label
      ctx.strokeStyle = v.speedKmph > 55 ? '#ef4444' : '#06b6d4';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(v.x - 3, v.y - 3, v.length + 6, v.width + 6);

      ctx.fillStyle = v.speedKmph > 55 ? '#ef4444' : '#06b6d4';
      ctx.font = '9px JetBrains Mono';
      ctx.fillText(`${v.type} [${v.speedKmph} km/h]`, v.x, v.y - 6);
      ctx.fillText(v.id, v.x, v.y + v.width + 12);
    });

    // Optical timestamp
    const now = new Date();
    qs('#cctvOsdTime').textContent = now.toISOString().replace('T', ' ').slice(0, 19) + ' IST';

    App.cctvAnimationId = requestAnimationFrame(draw);
  }
  draw();
}

function openNearestCctv(coords) {
  if (!App.config?.cctv_cameras) return;
  let nearest = App.config.cctv_cameras[0];
  let minDist = 1e9;
  App.config.cctv_cameras.forEach(c => {
    const d = Math.hypot(c.coords[0] - coords[0], c.coords[1] - coords[1]);
    if (d < minDist) { minDist = d; nearest = c; }
  });
  openCctvStream(nearest);
}

function renderCctvWall() {
  const container = qs('#cctvWallGrid');
  if (!container || !App.config?.cctv_cameras) return;

  container.innerHTML = App.config.cctv_cameras.map(cam => `
    <article class="cctv-card" onclick="openCctvStreamById('${cam.id}')">
      <div class="cctv-card-header">
        <h4>${cam.name}</h4>
        <span class="kpi-chip ${cam.status === 'online' ? 'green-text' : 'red-text'}">● ${cam.status.toUpperCase()}</span>
      </div>
      <div class="cctv-view-wrap">
        <canvas id="thumb_${cam.id}" width="320" height="180"></canvas>
        <div class="cctv-osd-top"><span>${cam.id}</span><span>${cam.fps} FPS</span></div>
        <div class="cctv-osd-bottom"><span>ANPR: ACTIVE</span><span>${cam.vehicle_count_min} veh/m</span></div>
      </div>
      <div class="cctv-card-footer">
        <span>${cam.direction}</span>
        <span class="alert-fly-link">Click to Expand ↗</span>
      </div>
    </article>
  `).join('');

  // Draw simple preview on thumbnails
  App.config.cctv_cameras.forEach(cam => {
    const cvs = qs(`#thumb_${cam.id}`);
    if (cvs) {
      const c = cvs.getContext('2d');
      c.fillStyle = '#0f172a'; c.fillRect(0, 0, cvs.width, cvs.height);
      c.fillStyle = '#1e293b'; c.fillRect(0, 70, cvs.width, 70);
      c.strokeStyle = '#38bdf8'; c.strokeRect(60, 80, 40, 20);
      c.strokeRect(180, 95, 50, 22);
    }
  });
}

window.openCctvStreamById = id => {
  const cam = App.config.cctv_cameras.find(c => c.id === id);
  if (cam) openCctvStream(cam);
};

// ================= VMS & PATROL LAYERS =================
function renderVmsLayer() {
  App.groups.vms.clearLayers();
  if (!App.config?.vms_signs) return;

  App.config.vms_signs.forEach(v => {
    const icon = L.divIcon({
      className: '',
      html: `<div class="marker-vms" title="${v.message}">🖵 ${v.id}</div>`,
      iconSize: [40, 20],
      iconAnchor: [20, 10],
    });
    const marker = L.marker(v.coords, { icon });
    marker.bindPopup(`
      <div class="map-popup">
        <span class="kpi-chip warning">VARIABLE MESSAGE SIGNBOARD</span>
        <h4>${v.id} · ${v.location}</h4>
        <div class="vms-preview-box" style="margin: 6px 0;">
          <div class="vms-led-text">${v.message}</div>
        </div>
      </div>
    `);
    App.groups.vms.addLayer(marker);
  });
}

function renderPatrolLayer() {
  App.groups.patrols.clearLayers();
  if (!App.config?.patrol_units) return;

  App.config.patrol_units.forEach(p => {
    const icon = L.divIcon({
      className: '',
      html: `
        <div class="marker-patrol">
          <div class="patrol-beacon"></div>
          <div class="patrol-pin">🚔 ${p.id}</div>
        </div>
      `,
      iconSize: [52, 22],
      iconAnchor: [26, 11],
    });
    const marker = L.marker(p.coords, { icon });
    marker.bindPopup(`
      <div class="map-popup">
        <span class="kpi-chip primary">POLICE PATROL UNIT</span>
        <h4>${p.name} (${p.id})</h4>
        <p>Type: <b>${p.type}</b></p>
        <p>In-Charge: <b>${p.officer}</b></p>
        <p>Assigned Sector: <b>${p.zone}</b></p>
        <p>Status: <b class="green-text">${p.status.toUpperCase()}</b></p>
        <button class="btn small primary" style="margin-top:6px;" onclick="openDispatchModal('${p.id}')">Deploy Unit</button>
      </div>
    `);
    App.groups.patrols.addLayer(marker);
  });
}

function renderDispatchView() {
  const container = qs('#patrolList');
  if (!container || !App.config?.patrol_units) return;

  container.innerHTML = App.config.patrol_units.map(p => `
    <div class="patrol-card">
      <div>
        <strong>${p.name} (${p.id})</strong>
        <div style="font-size:11px;color:#64748b;margin-top:2px;">${p.type} · ${p.officer} · Sector: ${p.zone}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="patrol-status-pill ${p.status}">${p.status.replace('_', ' ')}</span>
        <button class="btn small primary" onclick="quickDispatch('${p.zone}')">Deploy</button>
      </div>
    </div>
  `).join('');

  // Populate selects
  const unitSel = qs('#dispatchUnitSelect');
  if (unitSel) {
    unitSel.innerHTML = App.config.patrol_units.map(p => `<option value="${p.id}">${p.name} (${p.id})</option>`).join('');
  }
  const targetSel = qs('#dispatchTargetSelect');
  if (targetSel) {
    targetSel.innerHTML = Object.keys(App.config.corridors).map(z => `<option value="${z}">${z}</option>`).join('');
  }
}

async function quickDispatch(targetName) {
  setView('dispatch');
  const targetSel = qs('#dispatchTargetSelect');
  if (targetSel) targetSel.value = targetName;
  toast(`Selected dispatch target: ${targetName}`);
}

async function handleDispatchSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const unitId = form.elements.unit_id.value;
  const target = form.elements.target.value;
  const msg = qs('#dispatchMessage');

  try {
    const res = await api('/api/dispatch', {
      method: 'POST',
      body: JSON.stringify({ unit_id: unitId, target }),
    });
    msg.textContent = `Unit ${unitId} dispatched to ${target}!`;
    toast(`🚔 Patrol ${unitId} is en-route to ${target}`);
    await loadState();
    renderDispatchView();
  } catch (err) {
    msg.textContent = err.message;
  }
}

// ================= EMERGENCY GREEN CORRIDOR / VIP PROTOCOL =================
function playTacticalChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1760, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.36);
  } catch (e) {
    // AudioContext might be restricted until user interaction
  }
}

function openGreenCorridorModal() {
  const modal = qs('#greenCorridorModal');
  if (!modal) return;
  modal.classList.add('show');
  updateGreenCorridorPreview();
}

function closeGreenCorridorModal() {
  const modal = qs('#greenCorridorModal');
  if (!modal) return;
  modal.classList.remove('show');
}

function updateGreenCorridorPreview() {
  const orig = qs('#gcOrigin')?.value || 'Podar Hospital & SASMIRA';
  const dest = qs('#gcDestination')?.value || 'Bandra-Worli Sea Link Toll';
  const speed = parseInt(qs('#gcSpeed')?.value || '65', 10);
  if (qs('#gcSpeedVal')) qs('#gcSpeedVal').textContent = `${speed} km/h`;

  let dist = 4.5;
  let stdTime = 14.2;
  let routeName = 'Annie Besant Rd ➔ Worli Sea Face ➔ Sea Link Express';
  let signals = [
    'Podar Hospital Gate', 'Lotus Junction', 'Worli Dairy Gap', 'Sea Face North', 'Sea Link Toll Portal'
  ];

  if (orig.includes('Worli Naka') || dest.includes('Coastal Road')) {
    dist = 3.2;
    stdTime = 11.5;
    routeName = 'Worli Naka ➔ Dr E Moses ➔ Coastal Tunnel Link';
    signals = ['Worli Naka Central Hub', 'Nehru Centre Cross', 'Coastal Ramp Portal'];
  } else if (orig.includes('Haji Ali')) {
    dist = 5.8;
    stdTime = 18.0;
    routeName = 'Haji Ali Spine ➔ Sea Face ➔ Sea Link Outbound';
    signals = ['Haji Ali Roundabout', 'Lotus Junction', 'Worli Dairy Gap', 'Sea Link Toll Portal'];
  }

  const greenTime = (dist / speed * 60).toFixed(1);
  const saved = Math.max(0, (stdTime - greenTime)).toFixed(1);

  if (qs('#gcPreviewRoute')) qs('#gcPreviewRoute').textContent = routeName;
  if (qs('#gcPreviewDist')) qs('#gcPreviewDist').textContent = `Distance: ${dist} km · SCADA Preemption: ${signals.length} Signals`;
  if (qs('#gcPreviewOldTime')) qs('#gcPreviewOldTime').textContent = `~${stdTime}m Normal`;
  if (qs('#gcPreviewNewTime')) qs('#gcPreviewNewTime').textContent = `⚡ ${greenTime}m Express`;
  if (qs('#gcPreviewSaved')) qs('#gcPreviewSaved').textContent = `Saves ~${saved} mins`;

  const sigList = qs('#gcSignalsList');
  if (sigList) {
    sigList.innerHTML = signals.map(s => `
      <div class="gc-sig-item"><span class="sig-dot green"></span><span>${s}</span></div>
    `).join('');
  }
}

async function handleGreenCorridorSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const payload = {
    mission_type: form.elements.gcMission?.value || 'Critical Organ Transport (Cardiac)',
    origin: form.elements.gcOrigin?.value || 'Podar Hospital & SASMIRA',
    destination: form.elements.gcDestination?.value || 'Bandra-Worli Sea Link Toll',
    escort_unit: form.elements.gcEscort?.value || 'PATROL-01',
    target_speed: parseInt(form.elements.gcSpeed?.value || '65', 10),
    vehicle_callsign: form.elements.gcCallsign?.value || 'EMS-AMB-09',
  };

  try {
    const res = await api('/api/green-corridor/activate', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    closeGreenCorridorModal();
    playTacticalChime();
    toast(`⚡ GREEN CORRIDOR ACTIVE: ${payload.vehicle_callsign} en route (${payload.target_speed} km/h)`);
    renderGreenCorridor(res.green_corridor);
    await loadState();
  } catch (err) {
    toast(`Failed to activate: ${err.message}`);
  }
}

function clearGreenCorridorLayers() {
  if (App.groups.greenCorridor) App.groups.greenCorridor.clearLayers();
  if (App.greenCorridorTimer) {
    clearInterval(App.greenCorridorTimer);
    App.greenCorridorTimer = null;
  }
  if (App.greenCorridorAnim) {
    cancelAnimationFrame(App.greenCorridorAnim);
    App.greenCorridorAnim = null;
  }
}

function renderGreenCorridor(gc) {
  if (!gc) return;
  App.greenCorridor = gc;
  clearGreenCorridorLayers();

  const hud = qs('#greenCorridorHud');
  if (hud) {
    hud.classList.add('show');
    if (qs('#gcHudRoute')) qs('#gcHudRoute').textContent = `${gc.origin} ➔ ${gc.destination}`;
    if (qs('#gcHudSpeed')) qs('#gcHudSpeed').textContent = `${gc.speed_kmph} km/h`;
    if (qs('#gcHudSignals')) qs('#gcHudSignals').textContent = `${gc.signals?.length || 5}/${gc.signals?.length || 5} GREEN`;
    if (qs('#gcHudEscort')) qs('#gcHudEscort').textContent = gc.escort_unit || 'PATROL-01';
  }

  // Double-cased polyline: glow casing + bright emerald core + animated flow dash
  const casing = L.polyline(gc.coords, {
    color: '#059669',
    weight: 12,
    opacity: 0.65,
    lineCap: 'round',
    lineJoin: 'round',
  });
  const core = L.polyline(gc.coords, {
    color: '#10b981',
    weight: 6,
    opacity: 0.95,
    lineCap: 'round',
    lineJoin: 'round',
  });
  const flow = L.polyline(gc.coords, {
    color: '#ffffff',
    weight: 3,
    dashArray: '10, 18',
    opacity: 0.95,
    className: 'leaflet-green-corridor-flow',
  });

  App.groups.greenCorridor.addLayer(casing);
  App.groups.greenCorridor.addLayer(core);
  App.groups.greenCorridor.addLayer(flow);

  // Render Green Wave Signals
  (gc.signals || []).forEach(sig => {
    const icon = L.divIcon({
      className: '',
      html: `
        <div class="green-wave-signal-badge">
          <span class="corridor-pulse-dot"></span>
          <span>🟢 ${sig.id}: HELD</span>
        </div>
      `,
      iconSize: [110, 24],
      iconAnchor: [55, 12],
    });
    const marker = L.marker(sig.coords, { icon });
    marker.bindPopup(`
      <div class="map-popup">
        <span class="kpi-chip primary">SCADA PREEMPTION OVERRIDE</span>
        <h4>${sig.name}</h4>
        <p>Signal ID: <b>${sig.id}</b></p>
        <p>Status: <b class="emerald-text">GREEN WAVE HELD (${sig.phase_sec}s lock)</b></p>
        <p>Priority Vehicle: <b>${gc.callsign} (${gc.mission_type})</b></p>
        <p>Cross-traffic: <b>ALL LANES LOCKED RED</b></p>
      </div>
    `);
    App.groups.greenCorridor.addLayer(marker);
  });

  // Ambulance / Convoy Marker
  const ambIcon = L.divIcon({
    className: '',
    html: `
      <div class="ambulance-marker-pin">
        <div class="ambulance-beacon-ring"></div>
        <div class="ambulance-badge">🚑 ${gc.callsign}</div>
      </div>
    `,
    iconSize: [110, 36],
    iconAnchor: [55, 18],
  });

  const ambMarker = L.marker(gc.coords[0], { icon: ambIcon, zIndexOffset: 2000 });
  ambMarker.bindPopup(`
    <div class="map-popup">
      <span class="kpi-chip primary">EMERGENCY EXPRESS CONVOY</span>
      <h4>${gc.callsign}</h4>
      <p>Mission: <b>${gc.mission_type}</b></p>
      <p>Escort: <b>${gc.escort_unit}</b></p>
      <p>Target Speed: <b class="emerald-text">${gc.speed_kmph} km/h</b></p>
      <p>Origin: <b>${gc.origin}</b></p>
      <p>Destination: <b>${gc.destination}</b></p>
    </div>
  `);
  App.groups.greenCorridor.addLayer(ambMarker);

  // Smooth vehicle movement animation along waypoints
  const waypoints = gc.coords;
  const loopDuration = Math.max(14000, (gc.green_wave_time_min || 4) * 3500);
  const startTime = performance.now();

  function animateVehicle(now) {
    const elapsed = now - startTime;
    const t = (elapsed % loopDuration) / loopDuration;
    const totalSegments = waypoints.length - 1;
    const segIndex = Math.min(Math.floor(t * totalSegments), totalSegments - 1);
    const segT = (t * totalSegments) - segIndex;
    const p1 = waypoints[segIndex];
    const p2 = waypoints[segIndex + 1];
    const lat = p1[0] + (p2[0] - p1[0]) * segT;
    const lng = p1[1] + (p2[1] - p1[1]) * segT;

    ambMarker.setLatLng([lat, lng]);
    App.greenCorridorAnim = requestAnimationFrame(animateVehicle);
  }
  App.greenCorridorAnim = requestAnimationFrame(animateVehicle);

  // Countdown timer in HUD
  let remainingSec = Math.round((gc.green_wave_time_min || 4.2) * 60);
  function updateTimer() {
    if (remainingSec <= 0) {
      if (qs('#gcHudEta')) qs('#gcHudEta').textContent = 'ARRIVED';
      return;
    }
    const m = Math.floor(remainingSec / 60);
    const s = remainingSec % 60;
    if (qs('#gcHudEta')) qs('#gcHudEta').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    remainingSec--;
  }
  updateTimer();
  App.greenCorridorTimer = setInterval(updateTimer, 1000);

  // Fit bounds to corridor
  const bounds = L.latLngBounds(gc.coords);
  App.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
}

async function deactivateGreenCorridor() {
  try {
    await api('/api/green-corridor/deactivate', { method: 'POST' });
    clearGreenCorridorLayers();
    App.greenCorridor = null;
    const hud = qs('#greenCorridorHud');
    if (hud) hud.classList.remove('show');
    toast('Emergency Green Corridor stood down. Regular SCADA cycles restored.');
    await loadState();
  } catch (err) {
    toast(`Error deactivating: ${err.message}`);
  }
}

// ================= SPATIAL EVENTS (INCIDENTS & WORK) =================
function renderEventsLayer() {
  App.groups.events.clearLayers();
  if (!App.state) return;

  // 1. Incidents
  App.state.incidents.forEach(i => {
    const marker = L.marker([i.lat, i.lon], {
      icon: L.divIcon({
        className: '',
        html: `<div class="marker-wrapper marker-incident"><div class="marker-beacon"></div><div class="marker-badge"><span>!</span></div></div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 28],
      }),
    });
    marker.bindPopup(`
      <div class="map-popup">
        <span class="kpi-chip danger">INCIDENT REPORT</span>
        <h4>${i.incident_type}</h4>
        <p><strong>${i.zone}</strong> · ${i.lane}</p>
        <p>${i.description}</p>
        <div class="popup-stat-grid">
          <div class="popup-stat">Severity: <b>${i.severity.toUpperCase()}</b></div>
          <div class="popup-stat">Source: <b>${i.demo_seed ? 'DEMO' : 'Officer'}</b></div>
          <div class="popup-stat">GPS: <b>${i.lat.toFixed(4)}, ${i.lon.toFixed(4)}</b></div>
        </div>
      </div>
    `);
    App.groups.events.addLayer(marker);
  });

  // 2. Construction
  App.state.constructions.forEach(c => {
    const marker = L.marker([c.lat, c.lon], {
      icon: L.divIcon({
        className: '',
        html: `<div class="marker-wrapper marker-construction"><div class="marker-beacon"></div><div class="marker-badge"><span>▱</span></div></div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 28],
      }),
    });
    marker.bindPopup(`
      <div class="map-popup">
        <span class="kpi-chip warning">ROAD WORK ZONE</span>
        <h4>${c.title}</h4>
        <p><strong>${c.zone}</strong> · ${c.lane}</p>
        <p>${c.description}</p>
        <div class="popup-stat-grid">
          <div class="popup-stat">Impact: <b>${c.impact.toUpperCase()}</b></div>
          <div class="popup-stat">GPS: <b>${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}</b></div>
        </div>
      </div>
    `);
    App.groups.events.addLayer(marker);
  });
}

// ================= KPIs & TELEMETRY =================
function renderKPIs() {
  if (!App.state?.summary) return;
  const s = App.state.summary;
  const ctx = App.state.context;

  if (ctx) {
    if (qs('#ctxPeriod')) qs('#ctxPeriod').textContent = ctx.period || 'Operational Flow';
    if (qs('#ctxUnit')) qs('#ctxUnit').textContent = ctx.unit || 'MUMBAI POLICE · WORLI C4i';
    if (qs('#ctxWeather')) qs('#ctxWeather').textContent = ctx.weather || '29°C Clear';
    if (qs('#ctxTide')) qs('#ctxTide').textContent = ctx.tide || 'Mid Tide';
    if (qs('#ctxCoastal')) qs('#ctxCoastal').textContent = ctx.coastal_road_status || 'Open Both Arms';
    if (qs('#ctxSeaLink')) qs('#ctxSeaLink').textContent = ctx.sea_link_status || '80 km/h Normal';
    if (qs('#sideItms')) qs('#sideItms').textContent = ctx.itms_status || '99.8% OK';
    if (qs('#sideViolations')) qs('#sideViolations').textContent = `${ctx.anpr_violations_today || 94} Today`;
    if (qs('#sidePatrolCount')) qs('#sidePatrolCount').textContent = `${ctx.active_patrols || 3} Active`;
  }

  if (qs('#kpiDensity')) qs('#kpiDensity').textContent = s.average_density;
  const densityBar = qs('#kpiDensityBar');
  if (densityBar) {
    densityBar.style.width = `${s.average_density}%`;
    densityBar.style.backgroundColor = s.average_density < 38 ? '#10b981' : s.average_density < 60 ? '#f59e0b' : s.average_density < 78 ? '#f97316' : '#ef4444';
  }

  const badge = qs('#kpiDensityBadge');
  if (badge) {
    const levelText = s.average_density < 38 ? 'Free Flow' : s.average_density < 60 ? 'Moderate' : s.average_density < 78 ? 'Heavy' : 'Severe';
    badge.textContent = levelText;
    badge.className = `kpi-badge zone-status ${levelText.split(' ')[0]}`;
  }

  if (qs('#kpiSpeed')) qs('#kpiSpeed').textContent = s.average_speed_kmph;
  if (qs('#kpiIncidents')) qs('#kpiIncidents').textContent = s.active_incidents;
  if (qs('#kpiConstruction')) qs('#kpiConstruction').textContent = s.active_constructions;
  if (qs('#sideDelay')) qs('#sideDelay').textContent = `${s.network_delay_minutes} min`;

  // Update VMS LED preview
  if (App.state.vms_signs?.[0] && qs('#vmsLedText')) {
    qs('#vmsLedText').textContent = App.state.vms_signs[0].message;
  }
}

function renderAlerts() {
  const feed = qs('#alertFeed');
  const summaryCount = qs('#alertSummaryCount');
  if (summaryCount && App.state?.alerts) {
    summaryCount.textContent = `${App.state.alerts.length} active events`;
  }

  if (!feed || !App.state?.alerts) return;

  if (!App.state.alerts.length) {
    feed.innerHTML = '<div class="empty-state">No critical alerts or lane blockages in sector.</div>';
    return;
  }

  feed.innerHTML = App.state.alerts.map(a => `
    <div class="alert-item ${a.priority}" data-lat="${a.lat}" data-lon="${a.lon}" data-title="${a.title}">
      <div class="alert-meta">
        <span class="alert-tag">${a.kind === 'incident' ? '🚨 Incident' : '🚧 Work Zone'}</span>
        <span>${a.priority} Priority</span>
      </div>
      <div class="alert-title">${a.title} ${a.demo_seed ? '<span class="demo-chip">DEMO</span>' : ''}</div>
      <div class="alert-detail">${a.detail}</div>
      <div class="alert-foot">
        <span>📍 ${a.lat.toFixed(4)}, ${a.lon.toFixed(4)}</span>
        <span class="alert-fly-link">Locate on Map ↗</span>
      </div>
    </div>
  `).join('');
}

function renderZoneStrip() {
  qs('#zoneStrip').innerHTML = App.state.predictions.map(p => `
    <article class="zone-card" data-zone="${p.zone}">
      <div class="top">
        <div>
          <span style="font-size:10px;font-weight:900;color:#0284c7;">${p.zone_code}</span>
          <h3>${p.zone}</h3>
        </div>
        <span class="zone-status ${p.level}">${p.level}</span>
      </div>
      <div class="zone-density-row">
        <div class="zone-density">${p.density}%</div>
        <div class="zone-speed-tag">${p.avg_speed_kmph} km/h</div>
      </div>
      <div class="zone-bar-bg">
        <div class="zone-bar-fill" style="width:${p.density}%; background-color:${densityColor(p.level)};"></div>
      </div>
      <div class="zone-metrics-footer">
        <span>Travel: ~${p.travel_time_minutes}m</span>
        <span class="zone-delay-pill ${p.delay_minutes > 0 ? 'delayed' : ''}">${p.delay_minutes > 0 ? `+${p.delay_minutes}m delay` : 'Normal'}</span>
        <span>${p.blackspot_count > 0 ? `⚠️ ${p.blackspot_count} Hazard` : '✓ Clear'}</span>
      </div>
    </article>
  `).join('');
}

async function loadState() {
  const horizon = qs('#horizonSelect')?.value || 0;
  App.state = await api(`/api/state?minutes=${horizon}`);
  renderKPIs();
  renderAlerts();
  renderZoneStrip();
  renderNetworkLayers();
  renderEventsLayer();
}

function populateZones() {
  const names = Object.keys(App.config.corridors);
  ['incidentZone', 'constructionZone'].forEach(id => {
    const sel = qs(`#${id}`);
    if (sel) sel.innerHTML = names.map(n => `<option value="${n}">${n}</option>`).join('');
  });
  updateLaneSelect('incident');
  updateLaneSelect('construction');
}

function updateLaneSelect(type) {
  const zoneSel = qs(`#${type}Zone`);
  if (!zoneSel) return;
  const zone = zoneSel.value;
  const laneSel = qs(`#${type}Lane`);
  if (App.config.corridors[zone] && laneSel) {
    laneSel.innerHTML = App.config.corridors[zone].lanes.map(l => `<option value="${l}">${l}</option>`).join('');
  }
}

// ================= ACCURATE MAP PICKER =================
function handleMapPick(type, latlng) {
  const latInput = qs(`#${type}Lat`);
  const lonInput = qs(`#${type}Lon`);
  latInput.value = latlng.lat.toFixed(6);
  lonInput.value = latlng.lng.toFixed(6);

  const map = type === 'incident' ? App.incidentMap : App.constructionMap;
  if (App.pickMarkers[type]) map.removeLayer(App.pickMarkers[type]);

  const marker = L.marker(latlng, { draggable: true }).addTo(map);
  marker.on('dragend', e => {
    const pos = e.target.getLatLng();
    latInput.value = pos.lat.toFixed(6);
    lonInput.value = pos.lng.toFixed(6);
  });
  App.pickMarkers[type] = marker;

  if (App.pickMode) {
    App.pickMode = null;
    qs('#pickBanner')?.classList.remove('show');
    App.map.getContainer().style.cursor = '';
  }
  toast(`Captured exact coordinates: ${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`);
}

function setPickMode(type) {
  App.pickMode = type;
  setView(type === 'incident' ? 'incidents' : 'construction');
  qs('#pickBanner')?.classList.add('show');
  App.map.getContainer().style.cursor = 'crosshair';
  toast(`Click the map to place the ${type} marker`);
}

function snapToCoords(type, lat, lon) {
  const latlng = L.latLng(parseFloat(lat), parseFloat(lon));
  const map = type === 'incident' ? App.incidentMap : App.constructionMap;
  map.setView(latlng, 16);
  handleMapPick(type, latlng);
}

window.locateCoords = (lat, lon, title) => {
  setView('operations');
  App.map.flyTo([lat, lon], 16, { duration: 0.8 });
  toast(`Located: ${title}`);
};

// ================= FORM SUBMISSIONS =================
async function submitIncident(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  const msg = qs('#incidentMessage');
  msg.classList.remove('error');
  msg.textContent = 'Saving report...';
  try {
    await api('/api/incidents', { method: 'POST', body: JSON.stringify(payload) });
    msg.textContent = 'Incident alert logged and active.';
    form.reset();
    populateZones();
    await Promise.all([loadIncidentTable(), loadState()]);
    toast('Incident published to C4i live map');
  } catch (err) {
    msg.classList.add('error');
    msg.textContent = err.message;
  }
}

async function submitConstruction(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  const msg = qs('#constructionMessage');
  msg.classList.remove('error');
  msg.textContent = 'Publishing work zone...';
  try {
    await api('/api/constructions', { method: 'POST', body: JSON.stringify(payload) });
    msg.textContent = 'Work zone published.';
    form.reset();
    setDefaultConstructionTimes();
    populateZones();
    await Promise.all([loadConstructionTable(), loadState()]);
    toast('Work zone published and active');
  } catch (err) {
    msg.classList.add('error');
    msg.textContent = err.message;
  }
}

// ================= TABLES & AUDIT LOGS =================
async function loadIncidentTable() {
  const rows = await api('/api/incidents');
  const tbody = qs('#incidentTable tbody');
  tbody.innerHTML = rows.map(i => `
    <tr>
      <td><b>#${i.id}</b></td>
      <td><span class="status-pill ${i.status}">${i.status}</span></td>
      <td><strong>${i.incident_type}</strong></td>
      <td><span class="severity-pill ${i.severity}">${i.severity}</span></td>
      <td>${i.zone}</td>
      <td>${i.lane}</td>
      <td><code>${i.lat.toFixed(4)}, ${i.lon.toFixed(4)}</code></td>
      <td>${i.demo_seed ? '<span class="demo-chip">DEMO</span>' : 'Officer'}</td>
      <td>${formatDateTime(i.created_at)}</td>
      <td><div class="action-group">
        ${i.status === 'active' ? `<button class="btn small secondary" data-resolve-incident="${i.id}">Resolve</button>` : ''}
        <button class="btn small danger" data-delete-incident="${i.id}">Delete</button>
      </div></td>
    </tr>
  `).join('');
}

async function loadConstructionTable() {
  const rows = await api('/api/constructions');
  const tbody = qs('#constructionTable tbody');
  tbody.innerHTML = rows.map(c => `
    <tr>
      <td><b>#${c.id}</b></td>
      <td><span class="status-pill ${c.status}">${c.status}</span></td>
      <td><strong>${c.title}</strong></td>
      <td><span class="severity-pill ${c.impact}">${c.impact}</span></td>
      <td>${c.zone}</td>
      <td>${c.lane}</td>
      <td>${formatDateTime(c.start_time)} → ${formatDateTime(c.end_time)}</td>
      <td><code>${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}</code></td>
      <td>${c.demo_seed ? '<span class="demo-chip">DEMO</span>' : 'Officer'}</td>
      <td><div class="action-group">
        ${c.status === 'active' ? `<button class="btn small secondary" data-close-construction="${c.id}">Close</button>` : ''}
        <button class="btn small danger" data-delete-construction="${c.id}">Delete</button>
      </div></td>
    </tr>
  `).join('');
}

// ================= FORECAST & ANALYTICS CHARTS =================
async function loadForecast() {
  const data = await api('/api/forecast');
  const zones = Object.keys(data.series);
  const labels = data.horizons.map(h => (h === 0 ? 'Now' : `+${h}m`));

  Chart.defaults.color = '#cbd5e1';
  Chart.defaults.borderColor = 'rgba(255, 255, 255, 0.08)';

  const colors = [
    '#f59e0b', '#10b981', '#fbbf24', '#ef4444',
    '#34d399', '#f97316', '#e2e8f0', '#8290a5',
  ];

  const datasets = zones.map((z, idx) => ({
    label: z,
    data: data.series[z].map(p => p.density),
    borderColor: colors[idx % colors.length],
    backgroundColor: colors[idx % colors.length] + '20',
    borderWidth: 2.5,
    pointRadius: 3,
    tension: 0.3,
  }));

  const forecastCanvas = qs('#forecastChart');
  if (forecastCanvas) {
    if (App.charts.forecast) App.charts.forecast.destroy();
    App.charts.forecast = new Chart(forecastCanvas, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { color: 'rgba(255, 255, 255, 0.06)' }, ticks: { color: '#94a3b8' } },
          y: { min: 0, max: 100, title: { display: true, text: 'Congestion Density (%)', color: '#f59e0b' }, grid: { color: 'rgba(255, 255, 255, 0.06)' }, ticks: { color: '#94a3b8' } },
        },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10, family: 'Inter' }, color: '#cbd5e1' } },
        },
      },
    });
  }

  const cardsContainer = qs('#forecastCards');
  if (cardsContainer) {
    cardsContainer.innerHTML = zones.map(z => {
      const end = data.series[z][data.series[z].length - 1];
      const now = data.series[z][0];
      return `
        <article class="forecast-card">
          <h3>${z}</h3>
          <div class="forecast-row"><span>Live Now</span><strong>${now.density}% · ${now.level}</strong></div>
          <div class="forecast-row"><span>+120 min</span><strong>${end.density}% · ${end.level}</strong></div>
          <div class="forecast-row"><span>Expected Speed</span><strong>${end.avg_speed_kmph} km/h</strong></div>
          <div class="forecast-row"><span>Model Confidence</span><strong>${end.confidence}%</strong></div>
        </article>
      `;
    }).join('');
  }
}

function renderAnalytics() {
  if (!App.state) return;
  const labels = App.state.predictions.map(p => p.zone);
  const density = App.state.predictions.map(p => p.density);
  const incidents = App.state.predictions.map(p => p.active_incidents);
  const constructions = App.state.predictions.map(p => p.active_constructions);

  if (App.charts.density) App.charts.density.destroy();
  App.charts.density = new Chart(qs('#densityChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Density %',
        data: density,
        backgroundColor: density.map(d => (d < 38 ? '#10b981' : d < 60 ? '#f59e0b' : d < 78 ? '#f97316' : '#ef4444')),
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#94a3b8' } },
        y: { beginAtZero: true, max: 100, grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#94a3b8' } },
      },
      plugins: { legend: { display: false } },
    },
  });

  if (App.charts.events) App.charts.events.destroy();
  App.charts.events = new Chart(qs('#eventChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Incidents', data: incidents, backgroundColor: '#ef4444', borderRadius: 4 },
        { label: 'Work Zones', data: constructions, backgroundColor: '#f59e0b', borderRadius: 4 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true, grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#94a3b8' } },
        y: { stacked: true, beginAtZero: true, grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#94a3b8' } },
      },
      plugins: { legend: { position: 'bottom', labels: { color: '#cbd5e1' } } },
    },
  });

  qs('#analyticsTable tbody').innerHTML = App.state.predictions.map(p => `
    <tr>
      <td><strong>${p.zone}</strong></td>
      <td>${p.length_km} km</td>
      <td>${p.density}%</td>
      <td><span class="zone-status ${p.level}">${p.level}</span></td>
      <td><strong>${p.avg_speed_kmph} km/h</strong></td>
      <td>${p.speed_limit} km/h</td>
      <td>${p.delay_minutes > 0 ? `+${p.delay_minutes} min` : 'None'}</td>
      <td>${p.travel_time_minutes} min</td>
      <td>${p.active_incidents + p.active_constructions} active</td>
      <td>${p.confidence}%</td>
    </tr>
  `).join('');
}

function setDefaultConstructionTimes() {
  const form = qs('#constructionForm');
  if (!form) return;
  const now = new Date();
  const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const localInput = d => {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  form.elements.start_time.value = localInput(now);
  form.elements.end_time.value = localInput(end);
}

// ================= SEARCH & VIEW PRESETS =================
function setupSearchAndPresets() {
  const searchInput = qs('#mapSearchInput');
  const dropdown = qs('#searchDropdown');
  const clearBtn = qs('#clearSearchBtn');

  const items = [];
  // Corridors
  for (const [name, cfg] of Object.entries(App.config.corridors)) {
    items.push({ name, type: 'Road Corridor', coords: cfg.coords[Math.floor(cfg.coords.length / 2)] });
  }
  // Blackspots
  (App.config.accident_blackspots || []).forEach(bs => {
    items.push({ name: bs.name, type: 'Blackspot ⚠️', coords: bs.coords, isBlackspot: true, data: bs });
  });
  // Cameras
  (App.config.cctv_cameras || []).forEach(c => {
    items.push({ name: c.name, type: 'CCTV Camera 📹', coords: c.coords, isCam: true, data: c });
  });
  // Landmarks
  (App.config.landmarks || []).forEach(lm => {
    items.push({ name: lm.name, type: lm.category, coords: lm.coords });
  });

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    clearBtn.classList.toggle('show', q.length > 0);

    if (q.length < 2) {
      dropdown.classList.remove('show');
      return;
    }

    const matches = items.filter(it => it.name.toLowerCase().includes(q) || it.type.toLowerCase().includes(q));
    if (!matches.length) {
      dropdown.innerHTML = '<div style="padding:10px;font-size:11px;color:#94a3b8;">No matching location found.</div>';
      dropdown.classList.add('show');
      return;
    }

    dropdown.innerHTML = matches.slice(0, 8).map(m => `
      <div class="search-result-item" data-name="${m.name}">
        <span><strong>${m.name}</strong></span>
        <span class="search-result-type">${m.type}</span>
      </div>
    `).join('');
    dropdown.classList.add('show');
  });

  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.classList.remove('show');
    dropdown.classList.remove('show');
  });

  dropdown.addEventListener('click', e => {
    const item = e.target.closest('.search-result-item');
    if (!item) return;
    const name = item.dataset.name;
    const match = items.find(it => it.name === name);
    if (match) {
      if (match.type === 'Road Corridor') {
        selectCorridor(match.name);
      } else if (match.isBlackspot) {
        App.map.flyTo(match.coords, 16, { duration: 0.8 });
        showBlackspotModal(match.data);
      } else if (match.isCam) {
        App.map.flyTo(match.coords, 16, { duration: 0.8 });
        openCctvStream(match.data);
      } else {
        App.map.flyTo(match.coords, 16, { duration: 0.8 });
        toast(`Focused: ${match.name}`);
      }
      dropdown.classList.remove('show');
      searchInput.value = match.name;
    }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.map-search-wrap')) dropdown.classList.remove('show');
  });

  // Presets
  const presetCoords = {
    all: { center: [19.0065, 72.8185], zoom: 14 },
    seaface: { center: [19.0050, 72.8145], zoom: 15 },
    sealink: { center: [19.0260, 72.8180], zoom: 14 },
    naka: { center: [18.9986, 72.8174], zoom: 16 },
    coastal: { center: [19.0020, 72.8120], zoom: 14 },
    prabhadevi: { center: [19.0180, 72.8280], zoom: 15 },
  };

  qsa('.preset-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = presetCoords[btn.dataset.preset];
      if (p) {
        App.map.flyTo(p.center, p.zoom, { duration: 0.8 });
        toast(`Zoomed to ${btn.textContent}`);
      }
    });
  });

  qs('#hudResetBtn')?.addEventListener('click', () => {
    App.map.flyTo(App.config.center, App.config.zoom, { duration: 0.8 });
  });

  qs('#closeInspectorBtn')?.addEventListener('click', deselectCorridor);
  qs('#closeCctvModal')?.addEventListener('click', () => {
    qs('#cctvModal').classList.remove('show');
    if (App.cctvAnimationId) cancelAnimationFrame(App.cctvAnimationId);
  });
  qs('#closeBsModal')?.addEventListener('click', () => {
    qs('#blackspotModal').classList.remove('show');
  });
  qs('#bsCloseModalBtn')?.addEventListener('click', () => {
    qs('#blackspotModal').classList.remove('show');
  });

  // Modal backdrop click dismiss
  qs('#blackspotModal')?.addEventListener('click', e => {
    if (e.target === qs('#blackspotModal')) qs('#blackspotModal').classList.remove('show');
  });
  qs('#cctvModal')?.addEventListener('click', e => {
    if (e.target === qs('#cctvModal')) {
      qs('#cctvModal').classList.remove('show');
      if (App.cctvAnimationId) cancelAnimationFrame(App.cctvAnimationId);
    }
  });
  qs('#greenCorridorModal')?.addEventListener('click', e => {
    if (e.target === qs('#greenCorridorModal')) closeGreenCorridorModal();
  });

  // Global ESC key dismiss
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      qs('#blackspotModal')?.classList.remove('show');
      qs('#cctvModal')?.classList.remove('show');
      closeGreenCorridorModal();
      if (App.cctvAnimationId) cancelAnimationFrame(App.cctvAnimationId);
      deselectCorridor();
    }
  });

  // Expose key handlers to window for inline Leaflet HTML popups
  window.quickDispatch = quickDispatch;
  window.showBlackspotModalFromMap = showBlackspotModalFromMap;
  window.showBlackspotModal = showBlackspotModal;
  window.locateCoords = function (lat, lon, label) {
    setView('operations');
    App.map.flyTo([lat, lon], 16, { duration: 0.8 });
    toast(`Focused on ${label}`);
  };

  qs('#cancelPickBtn')?.addEventListener('click', () => {
    App.pickMode = null;
    qs('#pickBanner')?.classList.remove('show');
    App.map.getContainer().style.cursor = '';
  });
}

// ================= EVENT BINDINGS =================
function bindEvents() {
  qsa('.nav-tab, .nav-item').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));

  // Display Mode Buttons (Clean Circles vs Focus vs Full)
  qsa('.mode-pill').forEach(btn => {
    btn.addEventListener('click', () => setTrafficDisplayMode(btn.dataset.mode));
  });

  // Basemap style pills
  qsa('.style-pill').forEach(btn => {
    btn.addEventListener('click', () => switchBasemap(btn.dataset.style));
  });

  // Layer Toggles
  qs('#layerHubs')?.addEventListener('change', e => {
    if (e.target.checked) App.map.addLayer(App.groups.sectorBubbles);
    else App.map.removeLayer(App.groups.sectorBubbles);
  });
  qs('#layerCorridors')?.addEventListener('change', e => {
    if (e.target.checked) {
      App.map.addLayer(App.groups.corridors);
      Object.keys(App.corridorLayers).forEach(z => showCorridorPolyline(z, z === App.selectedZone));
    } else {
      App.groups.corridors.clearLayers();
    }
  });
  qs('#layerBlackspots')?.addEventListener('change', e => {
    if (e.target.checked) App.map.addLayer(App.groups.blackspots);
    else App.map.removeLayer(App.groups.blackspots);
  });
  qs('#layerCameras')?.addEventListener('change', e => {
    if (e.target.checked) App.map.addLayer(App.groups.cameras);
    else App.map.removeLayer(App.groups.cameras);
  });
  qs('#layerVMS')?.addEventListener('change', e => {
    if (e.target.checked) App.map.addLayer(App.groups.vms);
    else App.map.removeLayer(App.groups.vms);
  });
  qs('#layerPatrols')?.addEventListener('change', e => {
    if (e.target.checked) App.map.addLayer(App.groups.patrols);
    else App.map.removeLayer(App.groups.patrols);
  });
  qs('#layerEvents')?.addEventListener('change', e => {
    if (e.target.checked) App.map.addLayer(App.groups.events);
    else App.map.removeLayer(App.groups.events);
  });

  qs('#horizonSelect')?.addEventListener('change', loadState);
  qs('#refreshBtn')?.addEventListener('click', async () => {
    await loadState();
    toast('C4i Telemetry synchronized');
  });

  qs('#jumpIncident')?.addEventListener('click', () => setView('incidents'));
  qs('#incidentZone')?.addEventListener('change', () => updateLaneSelect('incident'));
  qs('#constructionZone')?.addEventListener('change', () => updateLaneSelect('construction'));

  qsa('.pick-map').forEach(b => b.addEventListener('click', () => setPickMode(b.dataset.target)));
  qsa('.snap-btn').forEach(b => {
    b.addEventListener('click', () => snapToCoords(b.dataset.target, b.dataset.lat, b.dataset.lon));
  });

  qs('#incidentForm')?.addEventListener('submit', submitIncident);
  qs('#constructionForm')?.addEventListener('submit', submitConstruction);
  qs('#dispatchForm')?.addEventListener('submit', handleDispatchSubmit);

  // Green Corridor Controls
  qs('#openGreenCorridorBtn')?.addEventListener('click', openGreenCorridorModal);
  qs('#closeGreenCorridorModal')?.addEventListener('click', closeGreenCorridorModal);
  qs('#cancelGreenCorridorBtn')?.addEventListener('click', closeGreenCorridorModal);
  qs('#greenCorridorForm')?.addEventListener('submit', handleGreenCorridorSubmit);
  qs('#deactivateGreenCorridorBtn')?.addEventListener('click', deactivateGreenCorridor);
  qs('#gcOrigin')?.addEventListener('change', updateGreenCorridorPreview);
  qs('#gcDestination')?.addEventListener('change', updateGreenCorridorPreview);
  qs('#gcSpeed')?.addEventListener('input', updateGreenCorridorPreview);

  // Click on alert feed item
  qs('#alertFeed')?.addEventListener('click', e => {
    const item = e.target.closest('.alert-item');
    if (!item) return;
    const lat = parseFloat(item.dataset.lat);
    const lon = parseFloat(item.dataset.lon);
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
      App.map.flyTo([lat, lon], 16, { duration: 0.8 });
      toast(`Focused: ${item.dataset.title}`);
    }
  });

  // Click on corridor strip card
  qs('#zoneStrip')?.addEventListener('click', e => {
    const card = e.target.closest('.zone-card');
    if (!card) return;
    selectCorridor(card.dataset.zone);
  });

  // Table action buttons
  document.addEventListener('click', async e => {
    const ri = e.target.closest('[data-resolve-incident]');
    const di = e.target.closest('[data-delete-incident]');
    const cc = e.target.closest('[data-close-construction]');
    const dc = e.target.closest('[data-delete-construction]');

    try {
      if (ri) {
        await api(`/api/incidents/${ri.dataset.resolveIncident}/resolve`, { method: 'POST' });
        await Promise.all([loadIncidentTable(), loadState()]);
        toast('Incident resolved and archived');
      }
      if (di && confirm('Delete this incident record?')) {
        await api(`/api/incidents/${di.dataset.deleteIncident}`, { method: 'DELETE' });
        await Promise.all([loadIncidentTable(), loadState()]);
        toast('Incident record deleted');
      }
      if (cc) {
        await api(`/api/constructions/${cc.dataset.closeConstruction}/close`, { method: 'POST' });
        await Promise.all([loadConstructionTable(), loadState()]);
        toast('Work zone closed');
      }
      if (dc && confirm('Delete this construction record?')) {
        await api(`/api/constructions/${dc.dataset.deleteConstruction}`, { method: 'DELETE' });
        await Promise.all([loadConstructionTable(), loadState()]);
        toast('Construction record deleted');
      }
    } catch (err) {
      toast(err.message);
    }
  });
}

// ================= INITIALIZATION =================
async function init() {
  updateClock();
  setInterval(updateClock, 1000);

  App.config = await api('/api/config');
  initMaps();
  setupSearchAndPresets();
  populateZones();
  setDefaultConstructionTimes();
  bindEvents();
  renderBlackspotsLayer();
  renderCctvLayer();
  renderVmsLayer();
  renderPatrolLayer();

  await loadState();

  // Set default full visibility (both corridors & circle hubs visible)
  setTrafficDisplayMode('full');

  // Check if an Emergency Green Corridor is active
  try {
    const gcStatus = await api('/api/green-corridor/active');
    if (gcStatus?.active) {
      renderGreenCorridor(gcStatus);
    }
  } catch (err) {
    // Non-blocking
  }

  // Background refresh every 25s
  setInterval(() => {
    if (qs('#view-operations')?.classList.contains('active')) {
      loadState().catch(() => { });
    }
  }, 25000);
}

init().catch(err => {
  console.error('C4i initialization error:', err);
  toast(`System error: ${err.message}`);
});
