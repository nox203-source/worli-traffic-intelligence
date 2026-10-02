# Worli Traffic Intelligence Platform (v3.0)

A modern, high-fidelity real-time decision-support web platform for the Worli traffic division in Mumbai, featuring clean modern website architecture (Linear / Vercel style), spacious interactive map layouts, high-visibility Accident Blackspots intelligence, and capacity-weighted traffic simulation.

## Features & Upgrades
- **Modern Website Architecture (No Built-In Desktop Clutter)**:
  - Eliminated the heavy, cramped fixed desktop sidebar in favor of a **sleek, modern frosted-glass top navigation bar** (`backdrop-filter: blur(20px)`) with clean pill-tabs, live telemetry indicator, forecast selector, and clock.
  - Spacious, breathable layout with generous margins and subtle dark slate canvas (`#0b0d14`).
- **Expansive Hero Map Card**:
  - Full-width hero map container with rounded corners (`20px`) and floating frosted glass pill controls:
    - **Traffic Mode**: `🔘 Circle Zones (Clean)` · `⚡ Show on Click` · `🛣️ All Corridors`.
    - **Search & Sector Filters**: Minimalist search pill with one-click sector filters (`Worli Naka`, `Sea Face`, `Sea Link`, etc.).
    - **Basemap Style**: `🌿 Natural` · `🌙 Dark` · `🛰️ Satellite` · `🗺️ Street`.
- **High-Visibility Accident Blackspots (BLK) Intelligence & Popups**:
  - **Pulsating Map Markers**: High-visibility `[⚠️ BLK-01]` badge pins with animated danger pulses.
  - **Modern Tactical Leaflet Popups**: Floating card on the map with collision counts, roadway hazard factors, police advisories, and instant action buttons (`🚨 Dispatch`, `📋 Full Dossier`).
  - **Luxurious Modern Blackspot Modal**: Clean glass modal with danger badge, 4 metric cards, contributing hazard factor tag-pills, official advisory, and rapid dispatch.
- **Modern Web Buttons & Segmented Controls**:
  - Pill-shaped tactile controls with smooth transitions, subtle hover elevations, and zero retro clutter.
- **Clean Circle Zones & On-Demand Geometry**:
  - Centroid Sector Hubs show live density % and speed without visual spaghetti lines.
  - Corridor paths draw smoothly on-demand when hovering or clicking a junction or corridor card.
- **CARTO Basemap Key**:
  - Uses key `cb1_45s7_1_3d829709b69d55e1cf7f0aad` with `?key=...&v=2` for crisp, watermark-free tiles.
- **Accurate Real-World Road Corridors**:
  - Replaced rough model lines with 8 high-precision real road polylines directly traced from Mumbai OpenStreetMap data:
    1. **Worli Sea Face** (Khan Abdul Gaffar Khan Marg) — 2.80 km
    2. **Bandra-Worli Sea Link** (Rajiv Gandhi Sea Link) — 4.21 km
    3. **Dr Annie Besant Road** (Haji Ali to Century Bazaar) — 3.37 km
    4. **Dr E Moses Road** (Mahalaxmi Station to Worli Naka) — 2.39 km
    5. **Mumbai Coastal Road (Worli Sector)** — 4.23 km
    6. **Worli Naka Hub** (Central multi-way intersection) — 0.95 km
    7. **Prabhadevi Link** (Swatantrya Veer Savarkar Marg) — 2.75 km
    8. **Senapati Bapat Marg** (Tulsi Pipe Road commercial artery) — 3.73 km
- **Natural Vector Styling**:
  - Double-cased glowing polylines (outer contrast casing + inner neon/amber/emerald density core).
  - Real-time animated traffic flow motion along active lanes.
  - Pulsing beacon radar pins for field incident alerts and construction zones.
- **Key Spatial Landmarks**:
  - 12 verified Worli landmarks with spatial icons (Worli Naka Junction, Sea Link Toll, Sea Face Promenade, Coastal Road Interchange, Nehru Planetarium, Podar Hospital, Siddhivinayak Temple, Four Seasons, Century Bazaar, Worli Fort, Haji Ali).
- **Interactive Tools**:
  - **Quick Search & Filter**: Instant search for any road, junction, or landmark with smooth fly-to and highlight.
  - **View Presets**: One-click zoom presets for Worli Overview, Sea Face, Sea Link, Worli Naka, Coastal Road, and Prabhadevi.
  - **Floating Inspector**: Hover or click any corridor to view live speeds, delays, travel times, length, and lane breakdowns.
  - **Cursor GIS HUD**: Live Lat/Lon readout to 6 decimal places with zoom level and recenter button.
  - **Operational Context Bar**: Live peak hour classification (Morning/Evening Peak), Arabian Sea tide level, and weather.
- **Calibrated & Balanced Traffic Model**:
  - Diurnal curve reflecting Mumbai morning rush (08:30–11:30) and evening peak (16:30–20:30).
  - Capacity-weighted blockage formula (narrower roads experience higher congestion impact than 8-lane expressways).
  - Greenshields & Bureau of Public Roads (BPR) travel delay calculation based on real road lengths.
- **Officer Desks**:
  - Incident Desk and Construction Desk with interactive location picker, draggable pins, and auto-snap buttons.
  - Nearest road proximity helper with distance in meters.
  - Persistent SQLite storage in `data/traffic_control.db` and CSV export.

## Running the Application
Open this directory in PowerShell or VS Code and run:

```powershell
python server.py
```

Or on Windows:
```powershell
py server.py
```
Or double-click `start_windows.bat`.

Then visit in your web browser:
`http://127.0.0.1:5000`
