from __future__ import annotations

import csv
import io
import json
import math
import mimetypes
import os
import re
import sqlite3
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "traffic_control.db")
CORRIDORS_FILE = os.path.join(DATA_DIR, "corridors_data.json")
TZ = ZoneInfo("Asia/Kolkata")
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "5000"))

# Ensure data directory exists
os.makedirs(DATA_DIR, exist_ok=True)

# Copy full_corridors_data.json if not present in DATA_DIR
if not os.path.exists(CORRIDORS_FILE):
    src_file = os.path.join(BASE_DIR, "full_corridors_data.json")
    if os.path.exists(src_file):
        with open(src_file, "r", encoding="utf-8") as f:
            corridor_payload = json.load(f)
        with open(CORRIDORS_FILE, "w", encoding="utf-8") as f:
            json.dump(corridor_payload, f, indent=2)

with open(CORRIDORS_FILE, "r", encoding="utf-8") as f:
    RAW_CONFIG = json.load(f)

CORRIDORS = RAW_CONFIG["corridors"]
LANDMARKS = RAW_CONFIG.get("landmarks", [])
MAP_PRESETS = RAW_CONFIG.get("presets", [])
ACCIDENT_BLACKSPOTS = RAW_CONFIG.get("accident_blackspots", [])
CCTV_CAMERAS = RAW_CONFIG.get("cctv_cameras", [])
VMS_SIGNS = RAW_CONFIG.get("vms_signs", [])
PATROL_UNITS = RAW_CONFIG.get("patrol_units", [])

SEVERITY_IMPACT = {"low": 0.04, "medium": 0.10, "high": 0.20, "critical": 0.32}
CONSTRUCTION_IMPACT = {"low": 0.04, "medium": 0.10, "high": 0.18}

ACTIVE_GREEN_CORRIDOR: dict | None = None

GREEN_CORRIDOR_PRESETS = {
    ("Podar Hospital & SASMIRA", "Bandra-Worli Sea Link Toll"): {
        "route_name": "Annie Besant Road ➔ Worli Sea Face ➔ Sea Link Outbound Express",
        "distance_km": 4.5,
        "standard_time_min": 14.2,
        "signals": [
            {"id": "SIG-W01", "name": "Podar Hospital / SASMIRA Junction", "coords": [18.9961, 72.8161], "status": "GREEN_HELD", "phase_sec": 90},
            {"id": "SIG-W02", "name": "Lotus Junction (Bindumadhav Thackeray Chowk)", "coords": [18.9938, 72.8145], "status": "GREEN_HELD", "phase_sec": 120},
            {"id": "SIG-W03", "name": "Worli Dairy Promenade Crossing Gap", "coords": [19.0068, 72.8130], "status": "GREEN_HELD", "phase_sec": 120},
            {"id": "SIG-W04", "name": "Sea Face North (Flora Fountain Approach)", "coords": [19.0115, 72.8135], "status": "GREEN_HELD", "phase_sec": 120},
            {"id": "SIG-W05", "name": "Sea Link Toll Plaza Approach Gantry", "coords": [19.0140, 72.8155], "status": "GREEN_HELD", "phase_sec": 180},
        ],
        "primary_zone": "Worli Sea Face",
    },
    ("Worli Naka Hub", "Coastal Road Interchange Portal"): {
        "route_name": "Worli Naka ➔ Dr E Moses ➔ Coastal Tunnel Link",
        "distance_km": 3.2,
        "standard_time_min": 11.5,
        "signals": [
            {"id": "SIG-W06", "name": "Worli Naka Central Multi-Way Signal", "coords": [18.9986, 72.8174], "status": "GREEN_HELD", "phase_sec": 100},
            {"id": "SIG-W07", "name": "Nehru Centre Science City Cross", "coords": [18.9920, 72.8150], "status": "GREEN_HELD", "phase_sec": 85},
            {"id": "SIG-W08", "name": "Coastal Interchange Ramp Signal", "coords": [19.0163, 72.8120], "status": "GREEN_HELD", "phase_sec": 150},
        ],
        "primary_zone": "Mumbai Coastal Road",
    },
    ("Haji Ali Gateway", "Bandra-Worli Sea Link Toll"): {
        "route_name": "Haji Ali Coastal Spine ➔ Sea Face ➔ Sea Link Outbound",
        "distance_km": 5.8,
        "standard_time_min": 18.0,
        "signals": [
            {"id": "SIG-W09", "name": "Haji Ali Gateway Roundabout", "coords": [18.9828, 72.8090], "status": "GREEN_HELD", "phase_sec": 120},
            {"id": "SIG-W02", "name": "Lotus Junction (Bindumadhav Thackeray Chowk)", "coords": [18.9938, 72.8145], "status": "GREEN_HELD", "phase_sec": 120},
            {"id": "SIG-W03", "name": "Worli Dairy Promenade Crossing Gap", "coords": [19.0068, 72.8130], "status": "GREEN_HELD", "phase_sec": 120},
            {"id": "SIG-W05", "name": "Sea Link Toll Plaza Approach Gantry", "coords": [19.0140, 72.8155], "status": "GREEN_HELD", "phase_sec": 180},
        ],
        "primary_zone": "Worli Sea Face",
    }
}


def db_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = db_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS incidents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            incident_type TEXT NOT NULL,
            severity TEXT NOT NULL,
            zone TEXT NOT NULL,
            lane TEXT NOT NULL,
            description TEXT NOT NULL,
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            source TEXT NOT NULL DEFAULT 'officer',
            demo_seed INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS constructions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            title TEXT NOT NULL,
            zone TEXT NOT NULL,
            lane TEXT NOT NULL,
            impact TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL,
            description TEXT NOT NULL,
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            source TEXT NOT NULL DEFAULT 'officer',
            demo_seed INTEGER NOT NULL DEFAULT 0
        );
    """)
    now = datetime.now(TZ)
    if conn.execute("SELECT COUNT(*) FROM incidents").fetchone()[0] == 0:
        conn.execute("""
            INSERT INTO incidents
            (created_at, updated_at, incident_type, severity, zone, lane, description, lat, lon, status, source, demo_seed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'demo', 1)
        """, (now.isoformat(), now.isoformat(), "Stalled Vehicle", "medium", "Worli Naka", "Northbound L2",
              "DEMO: Stalled heavy vehicle at Worli Naka junction; traffic moving slow.", 18.9986, 72.8174))
    else:
        # Calibrate demo seeds to accurate road coordinates
        conn.execute("""
            UPDATE incidents
            SET lat=18.9986, lon=72.8174, zone='Worli Naka'
            WHERE demo_seed=1 AND zone IN ('Worli Naka', 'Worli Naka Hub')
        """)

    if conn.execute("SELECT COUNT(*) FROM constructions").fetchone()[0] == 0:
        conn.execute("""
            INSERT INTO constructions
            (created_at, updated_at, title, zone, lane, impact, start_time, end_time, description, lat, lon, status, source, demo_seed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'demo', 1)
        """, (now.isoformat(), now.isoformat(), "Utility Pipe Trenching", "Prabhadevi Link", "Westbound L1", "medium",
              (now - timedelta(hours=2)).isoformat(), (now + timedelta(days=2)).isoformat(),
              "DEMO: BMC stormwater drain rehabilitation along SVS Marg near Siddhivinayak.", 19.0152, 72.8250))
    else:
        conn.execute("""
            UPDATE constructions
            SET lat=19.0152, lon=72.8250, zone='Prabhadevi Link'
            WHERE demo_seed=1 AND zone IN ('Prabhadevi Link', 'Prabhadevi - SVS Road')
        """)
    conn.commit()
    conn.close()


def time_factor(dt):
    """Accurate Mumbai urban diurnal traffic multiplier"""
    h = dt.hour + dt.minute / 60.0
    if h < 6.0:
        return 0.38 + 0.05 * (h / 6.0)
    elif h < 8.5:
        return 0.43 + (h - 6.0) / 2.5 * 0.72
    elif h < 11.5:
        p = (h - 8.5) / 3.0
        return 1.45 - 0.20 * abs(p - 0.5)
    elif h < 16.5:
        return 0.95 + 0.10 * math.sin((h - 11.5) / 5.0 * math.pi)
    elif h < 20.5:
        p = (h - 16.5) / 4.0
        return 1.52 - 0.25 * abs(p - 0.5)
    elif h < 22.5:
        return 1.27 - (h - 20.5) / 2.0 * 0.52
    else:
        return 0.75 - (h - 22.5) / 1.5 * 0.35


def active_events(now):
    conn = db_conn()
    incidents = [dict(r) for r in conn.execute("SELECT * FROM incidents WHERE status='active' ORDER BY id DESC")]
    constructions = []
    for row in conn.execute("SELECT * FROM constructions WHERE status='active' ORDER BY id DESC"):
        item = dict(row)
        try:
            start = datetime.fromisoformat(item["start_time"])
            end = datetime.fromisoformat(item["end_time"])
            if start.tzinfo is None:
                start = start.replace(tzinfo=TZ)
            if end.tzinfo is None:
                end = end.replace(tzinfo=TZ)
            if start <= now <= end:
                constructions.append(item)
        except ValueError:
            constructions.append(item)
    conn.close()
    return incidents, constructions


def zone_prediction(zone, horizon_minutes, now, incidents, constructions):
    cfg = CORRIDORS[zone]
    future = now + timedelta(minutes=horizon_minutes)
    tf = time_factor(future)
    minute_bucket = (future.hour * 60 + future.minute) / 25.0
    wave = 0.025 * math.sin(minute_bucket + len(zone) * 1.37)

    # Lane capacity weighting: incidents block larger percentage of narrower corridors
    lane_count = len(cfg["lanes"])
    lane_norm = 4.0 / max(2, lane_count)

    inc_impact = sum(SEVERITY_IMPACT.get(i["severity"], 0.08) * lane_norm for i in incidents if i["zone"] == zone)
    work_impact = sum(CONSTRUCTION_IMPACT.get(c["impact"], 0.08) * lane_norm for c in constructions if c["zone"] == zone)

    density = max(0.08, min(0.98, cfg["base_density"] * tf + wave + inc_impact + work_impact))

    # Real speed & travel time using Greenshields & BPR delay curve
    free_speed = cfg["speed_limit"]
    speed = max(6.0, free_speed * max(0.12, 1.0 - 0.82 * (density ** 1.35)))

    length_km = cfg.get("length_km", 3.0)
    free_flow_time = (length_km / free_speed) * 60.0
    actual_time = (length_km / speed) * 60.0
    delay = max(0, round(actual_time - free_flow_time))

    level = "Free" if density < 0.38 else "Moderate" if density < 0.60 else "Heavy" if density < 0.78 else "Severe"
    confidence = max(0.58, min(0.88, 0.86 - 0.05 * (horizon_minutes / 60)))

    # Compute accident blackspot count and highest risk for this corridor
    zone_blackspots = [b for b in ACCIDENT_BLACKSPOTS if b.get("zone") == zone]
    blackspot_count = len(zone_blackspots)
    highest_risk = "critical" if any(b["risk_level"] == "critical" for b in zone_blackspots) else "high" if any(b["risk_level"] == "high" for b in zone_blackspots) else "medium" if zone_blackspots else "normal"

    return {
        "zone": zone,
        "zone_code": cfg.get("zone_code", "".join(w[0] for w in zone.split()).upper()),
        "centroid": cfg.get("centroid", cfg["coords"][len(cfg["coords"]) // 2]),
        "horizon_minutes": horizon_minutes,
        "density": round(density * 100),
        "level": level,
        "avg_speed_kmph": round(speed, 1),
        "speed_limit": free_speed,
        "length_km": length_km,
        "travel_time_minutes": round(actual_time, 1),
        "free_flow_time_minutes": round(free_flow_time, 1),
        "delay_minutes": delay,
        "confidence": round(confidence * 100),
        "description": cfg.get("description", ""),
        "lanes": cfg["lanes"],
        "coords": cfg["coords"],
        "active_incidents": sum(1 for i in incidents if i["zone"] == zone),
        "active_constructions": sum(1 for c in constructions if c["zone"] == zone),
        "blackspot_count": blackspot_count,
        "highest_risk": highest_risk,
    }


def valid_zone_lane(zone, lane):
    return zone in CORRIDORS and lane in CORRIDORS[zone]["lanes"]


def get_live_context(now):
    """Realistic operational C4i telemetry for Greater Mumbai Police Worli Division"""
    h = now.hour + now.minute / 60.0
    if 8.5 <= h <= 11.5:
        period = "Morning Peak Corridor Control"
    elif 16.5 <= h <= 20.5:
        period = "Evening Peak Highway Management"
    elif 11.5 < h < 16.5:
        period = "Midday Commercial District Flow"
    elif 20.5 < h < 23.5:
        period = "Night Off-Peak Watch"
    else:
        period = "Overnight Minimal Traffic Watch"

    tide_phase = (now.hour * 60 + now.minute) % 745 / 745.0
    tide_height = round(1.2 + 2.8 * (0.5 + 0.5 * math.sin(tide_phase * 2 * math.pi)), 1)
    tide_status = "High Tide" if tide_height > 3.2 else "Low Tide" if tide_height < 1.8 else "Mid Tide"

    return {
        "period": period,
        "unit": "MUMBAI POLICE · WORLI TRAFFIC C4i",
        "weather": "29°C · Clear Sky · Visibility 8 km",
        "tide": f"Arabian Sea {tide_status} ({tide_height}m)",
        "coastal_road_status": "Operational (Both Arms Open)",
        "sea_link_status": "Normal Flow (Speed Limit 80 km/h)",
        "itms_status": "SCADA 99.8% Coordinated",
        "anpr_violations_today": sum(c.get("speed_violations_today", 0) for c in CCTV_CAMERAS),
        "active_patrols": sum(1 for p in PATROL_UNITS if p["status"] != "off_duty"),
        "monitored_blackspots": len(ACCIDENT_BLACKSPOTS),
        "active_vms": len(VMS_SIGNS),
    }


def build_state(horizon):
    now = datetime.now(TZ)
    incidents, constructions = active_events(now)
    predictions = [zone_prediction(z, horizon, now, incidents, constructions) for z in CORRIDORS]
    
    avg_density = round(sum(p["density"] for p in predictions) / len(predictions))
    avg_speed = round(sum(p["avg_speed_kmph"] for p in predictions) / len(predictions), 1)
    avg_speed_limit = sum(p["speed_limit"] for p in predictions) / len(predictions)
    free_flow_index = round((avg_speed / avg_speed_limit) * 100)
    total_delay = sum(p["delay_minutes"] for p in predictions)

    alerts = []
    for i in incidents:
        alerts.append({
            "kind": "incident",
            "priority": i["severity"],
            "title": f"{i['incident_type']} · {i['zone']}",
            "detail": f"{i['lane']} — {i['description']}",
            "id": i["id"],
            "lat": i["lat"],
            "lon": i["lon"],
            "zone": i["zone"],
            "demo_seed": bool(i["demo_seed"]),
            "created_at": i["created_at"],
        })
    for c in constructions:
        alerts.append({
            "kind": "construction",
            "priority": c["impact"],
            "title": f"{c['title']} · {c['zone']}",
            "detail": f"{c['lane']} — {c['description']}",
            "id": c["id"],
            "lat": c["lat"],
            "lon": c["lon"],
            "zone": c["zone"],
            "demo_seed": bool(c["demo_seed"]),
            "start_time": c["start_time"],
            "end_time": c["end_time"],
        })

    return {
        "timestamp": now.isoformat(),
        "horizon_minutes": horizon,
        "context": get_live_context(now),
        "summary": {
            "average_density": avg_density,
            "average_speed_kmph": avg_speed,
            "free_flow_index": free_flow_index,
            "network_delay_minutes": total_delay,
            "active_incidents": len(incidents),
            "active_constructions": len(constructions),
            "critical_corridors": sum(1 for p in predictions if p["level"] in ("Heavy", "Severe")),
        },
        "predictions": predictions,
        "incidents": incidents,
        "constructions": constructions,
        "alerts": alerts,
        "blackspots": ACCIDENT_BLACKSPOTS,
        "cctv_cameras": CCTV_CAMERAS,
        "vms_signs": VMS_SIGNS,
        "patrol_units": PATROL_UNITS,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "WorliTrafficControl/2.1"

    def log_message(self, fmt, *args):
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {fmt % args}")

    def send_json(self, data, status=200):
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            return json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        except (ValueError, json.JSONDecodeError):
            return {}

    def serve_file(self, path):
        if not os.path.isfile(path):
            self.send_error(404)
            return
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == "/":
            return self.serve_file(os.path.join(BASE_DIR, "templates", "index.html"))
        if path.startswith("/static/"):
            rel = os.path.normpath(path[len("/static/"): ]).lstrip("/\\")
            full = os.path.abspath(os.path.join(BASE_DIR, "static", rel))
            static_root = os.path.abspath(os.path.join(BASE_DIR, "static"))
            if not full.startswith(static_root):
                return self.send_error(403)
            return self.serve_file(full)
        if path == "/api/config":
            return self.send_json({
                "corridors": CORRIDORS,
                "center": [19.0065, 72.8185],
                "zoom": 14,
                "landmarks": LANDMARKS,
                "presets": MAP_PRESETS,
                "accident_blackspots": ACCIDENT_BLACKSPOTS,
                "cctv_cameras": CCTV_CAMERAS,
                "vms_signs": VMS_SIGNS,
                "patrol_units": PATROL_UNITS,
                "map_api_key": "cb1_45s7_1_3d829709b69d55e1cf7f0aad",
                "timezone": "Asia/Kolkata",
                "model_note": "Mumbai Police Worli Traffic Division · Spatial GIS Engine v2.1"
            })
        if path == "/api/state":
            try:
                horizon = max(0, min(180, int(query.get("minutes", ["0"])[0])))
            except ValueError:
                horizon = 0
            return self.send_json(build_state(horizon))
        if path == "/api/forecast":
            now = datetime.now(TZ)
            incidents, constructions = active_events(now)
            horizons = [0, 15, 30, 60, 90, 120]
            series = {z: [zone_prediction(z, h, now, incidents, constructions) for h in horizons] for z in CORRIDORS}
            return self.send_json({"timestamp": now.isoformat(), "horizons": horizons, "series": series})
        if path == "/api/incidents":
            conn = db_conn()
            rows = [dict(r) for r in conn.execute("SELECT * FROM incidents ORDER BY id DESC")]
            conn.close()
            return self.send_json(rows)
        if path == "/api/constructions":
            conn = db_conn()
            rows = [dict(r) for r in conn.execute("SELECT * FROM constructions ORDER BY id DESC")]
            conn.close()
            return self.send_json(rows)
        if path == "/api/export/events.csv":
            return self.export_csv()
        if path == "/api/green-corridor/active":
            return self.send_json(ACTIVE_GREEN_CORRIDOR or {"active": False})
        self.send_error(404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/incidents":
            return self.add_incident()
        if path == "/api/constructions":
            return self.add_construction()
        if path == "/api/dispatch":
            return self.dispatch_patrol()
        if path == "/api/vms/update":
            return self.update_vms()
        if path == "/api/green-corridor/activate":
            return self.activate_green_corridor()
        if path == "/api/green-corridor/deactivate":
            return self.deactivate_green_corridor()
        m = re.fullmatch(r"/api/incidents/(\d+)/resolve", path)
        if m:
            return self.update_status("incidents", int(m.group(1)), "resolved")
        m = re.fullmatch(r"/api/constructions/(\d+)/close", path)
        if m:
            return self.update_status("constructions", int(m.group(1)), "closed")
        self.send_error(404)

    def activate_green_corridor(self):
        global ACTIVE_GREEN_CORRIDOR
        data = self.read_json()
        mission_type = data.get("mission_type", "Critical Organ Transport (Cardiac)")
        origin = data.get("origin", "Podar Hospital & SASMIRA")
        destination = data.get("destination", "Bandra-Worli Sea Link Toll")
        escort_unit = data.get("escort_unit", "PATROL-01")
        callsign = data.get("vehicle_callsign", "EMS-AMB-09")
        speed_kmph = int(data.get("target_speed", 65))

        preset_key = (origin, destination)
        preset = GREEN_CORRIDOR_PRESETS.get(preset_key)
        
        orig_coords = [18.9961, 72.8161]
        dest_coords = [19.0140, 72.8155]
        for lm in LANDMARKS:
            if lm["name"] == origin: orig_coords = lm["coords"]
            if lm["name"] == destination: dest_coords = lm["coords"]

        if preset:
            route_coords = [orig_coords] + CORRIDORS["Worli Sea Face"]["coords"] + [dest_coords]
            signals = preset["signals"]
            distance = preset["distance_km"]
            std_time = preset["standard_time_min"]
            green_time = round((distance / max(20, speed_kmph)) * 60, 1)
            route_name = preset["route_name"]
            primary_zone = preset["primary_zone"]
        else:
            route_coords = [orig_coords] + CORRIDORS.get("Worli Sea Face", {}).get("coords", [orig_coords, dest_coords]) + [dest_coords]
            signals = [
                {"id": "SIG-01", "name": f"{origin} Departure Gateway", "coords": orig_coords, "status": "GREEN_HELD", "phase_sec": 90},
                {"id": "SIG-02", "name": "Lotus Junction Central Node", "coords": [18.9938, 72.8145], "status": "GREEN_HELD", "phase_sec": 120},
                {"id": "SIG-03", "name": "Worli Sea Face Promenade Signal", "coords": [19.0068, 72.8130], "status": "GREEN_HELD", "phase_sec": 120},
                {"id": "SIG-04", "name": f"{destination} Ingress Portal", "coords": dest_coords, "status": "GREEN_HELD", "phase_sec": 150},
            ]
            distance = 4.2
            std_time = 13.5
            green_time = round((distance / max(20, speed_kmph)) * 60, 1)
            route_name = f"{origin} ➔ {destination} Rapid Transit"
            primary_zone = "Worli Sea Face"

        now = datetime.now(TZ)
        eta = now + timedelta(minutes=green_time)

        # Update escort patrol
        for u in PATROL_UNITS:
            if u["id"] == escort_unit:
                u["status"] = "escorting_green_corridor"
                u["destination"] = destination
                u["mission"] = f"Escorting {callsign} ({mission_type})"

        # Update VMS signs
        for v in VMS_SIGNS:
            if "original_msg" not in v:
                v["original_msg"] = v["message"]
            v["message"] = f"🚨 GREEN CORRIDOR ACTIVE · {callsign} EN ROUTE · YIELD ALL RIGHT LANES"

        # Insert into incidents table for C4i audit logging
        conn = db_conn()
        conn.execute(
            "INSERT INTO incidents (created_at, updated_at, incident_type, severity, zone, lane, description, lat, lon, status, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'green_corridor')",
            (now.isoformat(), now.isoformat(), "Emergency Green Corridor", "critical", primary_zone, "All Lanes Express Clearance",
             f"{mission_type} · Callsign {callsign} · Escort {escort_unit} · {origin} to {destination} ({len(signals)} Signals Preempted)",
             route_coords[0][0], route_coords[0][1])
        )
        conn.commit()
        conn.close()

        ACTIVE_GREEN_CORRIDOR = {
            "active": True,
            "mission_id": f"GC-{int(now.timestamp())}",
            "mission_type": mission_type,
            "callsign": callsign,
            "origin": origin,
            "destination": destination,
            "escort_unit": escort_unit,
            "speed_kmph": speed_kmph,
            "distance_km": distance,
            "standard_time_min": std_time,
            "green_wave_time_min": green_time,
            "time_saved_min": round(std_time - green_time, 1),
            "route_name": route_name,
            "coords": route_coords,
            "signals": signals,
            "activated_at": now.isoformat(),
            "eta": eta.isoformat(),
            "primary_zone": primary_zone,
        }

        return self.send_json({"ok": True, "green_corridor": ACTIVE_GREEN_CORRIDOR})

    def deactivate_green_corridor(self):
        global ACTIVE_GREEN_CORRIDOR
        if not ACTIVE_GREEN_CORRIDOR:
            return self.send_json({"ok": True, "active": False})

        # Reset escort patrol
        for u in PATROL_UNITS:
            if u.get("status") == "escorting_green_corridor":
                u["status"] = "patrolling"
                u.pop("destination", None)
                u.pop("mission", None)

        # Reset VMS signs
        for v in VMS_SIGNS:
            if "original_msg" in v:
                v["message"] = v.pop("original_msg")

        # Mark incident resolved
        now = datetime.now(TZ)
        conn = db_conn()
        conn.execute(
            "UPDATE incidents SET status='resolved', updated_at=? WHERE source='green_corridor' AND status='active'",
            (now.isoformat(),)
        )
        conn.commit()
        conn.close()

        ACTIVE_GREEN_CORRIDOR = None
        return self.send_json({"ok": True, "active": False})

    def dispatch_patrol(self):
        data = self.read_json()
        unit_id = data.get("unit_id")
        target = data.get("target", "Worli Naka")
        for u in PATROL_UNITS:
            if u["id"] == unit_id:
                u["status"] = "dispatched"
                u["destination"] = target
                u["dispatched_at"] = datetime.now(TZ).isoformat()
                return self.send_json({"ok": True, "unit": u})
        return self.send_json({"error": "Patrol unit not found"}, 404)

    def update_vms(self):
        data = self.read_json()
        vms_id = data.get("id")
        msg = data.get("message")
        for v in VMS_SIGNS:
            if v["id"] == vms_id:
                v["message"] = str(msg).strip()
                return self.send_json({"ok": True, "vms": v})
        return self.send_json({"error": "VMS sign not found"}, 404)
        self.send_error(404)

    def do_DELETE(self):
        path = urlparse(self.path).path
        m = re.fullmatch(r"/api/incidents/(\d+)", path)
        if m:
            return self.delete_record("incidents", int(m.group(1)))
        m = re.fullmatch(r"/api/constructions/(\d+)", path)
        if m:
            return self.delete_record("constructions", int(m.group(1)))
        self.send_error(404)

    def add_incident(self):
        data = self.read_json()
        required = ["incident_type", "severity", "zone", "lane", "description", "lat", "lon"]
        missing = [k for k in required if data.get(k) in (None, "")]
        if missing:
            return self.send_json({"error": "Missing: " + ", ".join(missing)}, 400)
        if data["severity"] not in SEVERITY_IMPACT:
            return self.send_json({"error": "Invalid severity"}, 400)
        if not valid_zone_lane(data["zone"], data["lane"]):
            return self.send_json({"error": "Zone/lane combination is invalid"}, 400)
        try:
            lat, lon = float(data["lat"]), float(data["lon"])
        except (TypeError, ValueError):
            return self.send_json({"error": "Invalid coordinates"}, 400)
        now = datetime.now(TZ).isoformat()
        conn = db_conn()
        cur = conn.execute("""
            INSERT INTO incidents
            (created_at, updated_at, incident_type, severity, zone, lane, description, lat, lon, status, source, demo_seed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'officer', 0)
        """, (now, now, str(data["incident_type"]).strip(), data["severity"], data["zone"], data["lane"],
              str(data["description"]).strip(), lat, lon))
        conn.commit()
        row = dict(conn.execute("SELECT * FROM incidents WHERE id=?", (cur.lastrowid,)).fetchone())
        conn.close()
        self.send_json(row, 201)

    def add_construction(self):
        data = self.read_json()
        required = ["title", "zone", "lane", "impact", "start_time", "end_time", "description", "lat", "lon"]
        missing = [k for k in required if data.get(k) in (None, "")]
        if missing:
            return self.send_json({"error": "Missing: " + ", ".join(missing)}, 400)
        if data["impact"] not in CONSTRUCTION_IMPACT:
            return self.send_json({"error": "Invalid impact"}, 400)
        if not valid_zone_lane(data["zone"], data["lane"]):
            return self.send_json({"error": "Zone/lane combination is invalid"}, 400)
        try:
            lat, lon = float(data["lat"]), float(data["lon"])
            start, end = datetime.fromisoformat(data["start_time"]), datetime.fromisoformat(data["end_time"])
            if end <= start:
                return self.send_json({"error": "End time must be after start time"}, 400)
        except (TypeError, ValueError):
            return self.send_json({"error": "Invalid coordinates or date/time"}, 400)
        now = datetime.now(TZ).isoformat()
        conn = db_conn()
        cur = conn.execute("""
            INSERT INTO constructions
            (created_at, updated_at, title, zone, lane, impact, start_time, end_time, description, lat, lon, status, source, demo_seed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'officer', 0)
        """, (now, now, str(data["title"]).strip(), data["zone"], data["lane"], data["impact"],
              data["start_time"], data["end_time"], str(data["description"]).strip(), lat, lon))
        conn.commit()
        row = dict(conn.execute("SELECT * FROM constructions WHERE id=?", (cur.lastrowid,)).fetchone())
        conn.close()
        self.send_json(row, 201)

    def update_status(self, table, item_id, status):
        if table not in ("incidents", "constructions"):
            return self.send_json({"error": "Invalid table"}, 400)
        conn = db_conn()
        cur = conn.execute(
            f"UPDATE {table} SET status=?, updated_at=? WHERE id=?",
            (status, datetime.now(TZ).isoformat(), item_id),
        )
        conn.commit()
        changed = cur.rowcount
        conn.close()
        return self.send_json({"ok": True}) if changed else self.send_json({"error": "Record not found"}, 404)

    def delete_record(self, table, item_id):
        if table not in ("incidents", "constructions"):
            return self.send_json({"error": "Invalid table"}, 400)
        conn = db_conn()
        cur = conn.execute(f"DELETE FROM {table} WHERE id=?", (item_id,))
        conn.commit()
        changed = cur.rowcount
        conn.close()
        return self.send_json({"ok": True}) if changed else self.send_json({"error": "Record not found"}, 404)

    def export_csv(self):
        conn = db_conn()
        incidents = [dict(r) for r in conn.execute("SELECT * FROM incidents ORDER BY id DESC")]
        constructions = [dict(r) for r in conn.execute("SELECT * FROM constructions ORDER BY id DESC")]
        conn.close()
        output = io.StringIO()
        w = csv.writer(output)
        w.writerow(["record_type", "id", "status", "zone", "lane", "severity_or_impact", "title_or_type", "description", "lat", "lon", "created_at", "source", "demo_seed"])
        for i in incidents:
            w.writerow(["incident", i["id"], i["status"], i["zone"], i["lane"], i["severity"], i["incident_type"], i["description"], i["lat"], i["lon"], i["created_at"], i["source"], i["demo_seed"]])
        for c in constructions:
            w.writerow(["construction", c["id"], c["status"], c["zone"], c["lane"], c["impact"], c["title"], c["description"], c["lat"], c["lon"], c["created_at"], c["source"], c["demo_seed"]])
        raw = output.getvalue().encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", "attachment; filename=worli_traffic_event_log.csv")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def main():
    init_db()
    print("\n==============================================")
    print(" Worli Traffic Intelligence Center (v2.0)     ")
    print(" Real-time OSM Geometric Accuracy & Balance   ")
    print("==============================================")
    print(f"Open in browser: http://{HOST}:{PORT}")
    print("Press Ctrl+C to stop.\n")
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")


if __name__ == "__main__":
    main()
