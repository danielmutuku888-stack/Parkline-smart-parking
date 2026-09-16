import json
import mimetypes
import os
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from Parking import ParkingLot, SlotStatus, VehicleType


ROOT = Path(__file__).parent
DATA_FILE = ROOT / "parking_data.json"
TEMP_DATA_FILE = ROOT / "parking_data.json.tmp"
lot = ParkingLot()
checkout_history = []

for index in range(1, 61):
    lot.add_slot(f"C{index}", VehicleType.CAR)
for index in range(1, 31):
    lot.add_slot(f"M{index}", VehicleType.MOTORCYCLE)
for index in range(1, 11):
    lot.add_slot(f"T{index}", VehicleType.TRUCK)


def save_data():
    data = {
        "active_tickets": [
            {
                "plate_number": ticket.plate_number,
                "vehicle_type": ticket.vehicle_type.value,
                "slot_id": ticket.slot.slot_id,
                "ticket_id": ticket.ticket_id,
                "entry_time": ticket.entry_time.isoformat(),
            }
            for ticket in lot.active_tickets.values()
        ],
        "checkout_history": checkout_history,
    }
    TEMP_DATA_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    TEMP_DATA_FILE.replace(DATA_FILE)


def load_data():
    global checkout_history
    if not DATA_FILE.exists():
        return
    try:
        saved_data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        checkout_history = saved_data.get("checkout_history", [])
        for saved_ticket in saved_data.get("active_tickets", []):
            slot = lot.slots.get(saved_ticket["slot_id"])
            vehicle_type = VehicleType(saved_ticket["vehicle_type"])
            if not slot or slot.status.value == "occupied":
                continue
            ticket = lot.vehicle_entry(saved_ticket["plate_number"], vehicle_type)
            ticket.ticket_id = saved_ticket["ticket_id"]
            ticket.entry_time = datetime.fromisoformat(saved_ticket["entry_time"])
            if ticket.slot.slot_id != slot.slot_id:
                lot.slots[ticket.slot.slot_id].status = SlotStatus.AVAILABLE
                lot.slots[ticket.slot.slot_id].ticket = None
                slot.status = SlotStatus.OCCUPIED
                slot.ticket = ticket
                ticket.slot = slot
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"Could not load saved parking data: {error}")


load_data()


def availability_payload():
    availability = lot.get_availability()
    return {
        vehicle_type.value: availability[vehicle_type]
        for vehicle_type in VehicleType
    }


def status_payload():
    return {
        "availability": availability_payload(),
        "active_tickets": [
            {
                "ticket_id": ticket.ticket_id,
                "plate_number": ticket.plate_number,
                "vehicle_type": ticket.vehicle_type.value,
                "slot_id": ticket.slot.slot_id,
                "entry_time": ticket.entry_time.isoformat(timespec="minutes"),
            }
            for ticket in lot.active_tickets.values()
        ],
        "checkout_history": checkout_history,
    }


class ParkingRequestHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            self.send_json(200, {"status": "ok"})
            return
        if path == "/api/status":
            self.send_json(200, status_payload())
            return
        self.serve_static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            payload = self.read_json()
            if path == "/api/entry":
                plate_number = str(payload.get("plate_number", "")).strip().upper()
                vehicle_type = VehicleType(str(payload.get("vehicle_type", "")).lower())
                if not plate_number:
                    raise ValueError("Plate number is required")
                ticket = lot.vehicle_entry(plate_number, vehicle_type)
                save_data()
                self.send_json(201, {
                    "message": f"Vehicle parked in slot {ticket.slot.slot_id}",
                    "ticket": {
                        "ticket_id": ticket.ticket_id,
                        "plate_number": ticket.plate_number,
                        "vehicle_type": ticket.vehicle_type.value,
                        "slot_id": ticket.slot.slot_id,
                        "entry_time": ticket.entry_time.isoformat(timespec="minutes"),
                    },
                })
                return
            if path == "/api/exit":
                plate_number = str(payload.get("plate_number", "")).strip().upper()
                if not plate_number:
                    raise ValueError("Plate number is required")
                active_ticket = lot.active_tickets.get(plate_number)
                if not active_ticket:
                    raise ValueError("No active ticket found for this vehicle")
                vehicle_type = active_ticket.vehicle_type.value
                receipt = lot.vehicle_exit(plate_number)
                receipt["vehicle_type"] = vehicle_type
                receipt["checked_out_at"] = datetime.now().isoformat(timespec="minutes")
                checkout_history.insert(0, receipt)
                save_data()
                self.send_json(200, {"message": "Vehicle checked out", "receipt": receipt})
                return
            self.send_json(404, {"error": "Endpoint not found"})
        except (ValueError, KeyError) as error:
            self.send_json(400, {"error": str(error)})
        except Exception as error:
            self.send_json(409, {"error": str(error)})

    def read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length) or b"{}")

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def serve_static(self, path):
        relative_path = "index.html" if path == "/" else path.lstrip("/")
        file_path = (ROOT / relative_path).resolve()
        if ROOT not in file_path.parents or not file_path.is_file():
            self.send_error(404)
            return
        content = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(file_path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, format, *args):
        print(f"{self.address_string()} - {format % args}")


if __name__ == "__main__":
    class ParkingServer(ThreadingHTTPServer):
        allow_reuse_address = True

    port = 8765
    server = ParkingServer(("0.0.0.0", port), ParkingRequestHandler)
    print(f"Smart Parking System running at http://localhost:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        server.server_close()