import hashlib
import json
import mimetypes
import math
import os
import re
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from Parking import ParkingLot, SlotStatus, VehicleType, calculate_parking_fee


ROOT = Path(__file__).parent
DATA_FILE = ROOT / "parking_data.json"
TEMP_DATA_FILE = ROOT / "parking_data.json.tmp"
lot = ParkingLot()
checkout_history = []
DEFAULT_RATE_TIERS = [
    {"max_minutes": 30, "amount": 0},
    {"max_minutes": 120, "amount": 50},
    {"max_minutes": 240, "amount": 100},
    {"max_minutes": 360, "amount": 300},
    {"max_minutes": None, "amount": 500},
]
VEHICLE_TYPES = ("car", "motorcycle", "truck")
rate_tiers = {
    vehicle_type: [dict(tier) for tier in DEFAULT_RATE_TIERS]
    for vehicle_type in VEHICLE_TYPES
}
data_lock = threading.RLock()


def validate_plate_number(value, allow_bay=False):
    plate_number = str(value or "").strip().upper()
    valid_plate = re.fullmatch(r"[A-Z0-9][A-Z0-9 -]{0,10}[A-Z0-9]", plate_number)
    valid_bay = allow_bay and re.fullmatch(r"[CMT]\d{1,2}", plate_number)
    if not valid_plate and not valid_bay:
        raise ValueError("Enter a valid plate number" + (" or bay ID" if allow_bay else ""))
    return plate_number


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
        "rate_tiers": rate_tiers,
    }
    TEMP_DATA_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    TEMP_DATA_FILE.replace(DATA_FILE)


def load_data():
    global checkout_history, rate_tiers
    if not DATA_FILE.exists():
        return
    try:
        saved_data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        checkout_history = saved_data.get("checkout_history", [])
        rate_tiers = validate_rate_tiers(saved_data.get("rate_tiers", rate_tiers))
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


def availability_payload():
    availability = lot.get_availability()
    return {
        vehicle_type.value: availability[vehicle_type]
        for vehicle_type in VehicleType
    }


def checkout_history_payload():
    occurrences = {}
    records = []
    for receipt in checkout_history:
        fingerprint = json.dumps(receipt, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        digest = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()
        occurrences[digest] = occurrences.get(digest, 0) + 1
        records.append({**receipt, "history_id": f"{digest}:{occurrences[digest]}"})
    return records


def status_payload():
    return {
        "availability": availability_payload(),
        "slots": [
            {
                "slot_id": slot.slot_id,
                "vehicle_type": slot.vehicle_type.value,
                "status": slot.status.value,
                "plate_number": slot.ticket.plate_number if slot.ticket else None,
                "entry_time": slot.ticket.entry_time.isoformat(timespec="minutes") if slot.ticket else None,
            }
            for slot in lot.slots.values()
        ],
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
        "checkout_history": checkout_history_payload(),
        "rate_tiers": rate_tiers,
    }


def validate_rate_tier_list(tiers):
    if not isinstance(tiers, list) or len(tiers) != 5:
        raise ValueError("Provide all five parking rate tiers")
    validated = []
    expected_limits = [30, 120, 240, 360, None]
    for tier, expected_limit in zip(tiers, expected_limits):
        if not isinstance(tier, dict) or tier.get("max_minutes") != expected_limit:
            raise ValueError("Rate tier limits must remain 30, 120, 240, 360, and over 360 minutes")
        amount = tier.get("amount")
        if isinstance(amount, bool) or not isinstance(amount, (int, float)) or not math.isfinite(amount) or amount < 0:
            raise ValueError("Rate amounts must be non-negative numbers")
        validated.append({"max_minutes": expected_limit, "amount": round(float(amount), 2)})
    return validated


def validate_rate_tiers(tiers):
    if isinstance(tiers, list):
        legacy_tiers = validate_rate_tier_list(tiers)
        return {vehicle_type: [dict(tier) for tier in legacy_tiers] for vehicle_type in VEHICLE_TYPES}
    if not isinstance(tiers, dict) or set(tiers) != set(VEHICLE_TYPES):
        raise ValueError("Provide parking rate tiers for cars, motorcycles, and trucks")
    return {
        vehicle_type: validate_rate_tier_list(tiers[vehicle_type])
        for vehicle_type in VEHICLE_TYPES
    }


def fee_for_minutes(minutes, vehicle_type):
    tiers = rate_tiers[vehicle_type.value]
    for tier in tiers:
        if tier["max_minutes"] is None or minutes <= tier["max_minutes"]:
            return tier["amount"]
    return tiers[-1]["amount"]


def quote_for(plate_number):
    ticket = lot.active_tickets.get(plate_number)
    if not ticket:
        ticket = next(
            (active for active in lot.active_tickets.values() if active.slot.slot_id.upper() == plate_number.upper()),
            None,
        )
    if not ticket:
        raise ValueError("No active ticket found for this vehicle")
    duration_minutes = max(1, math.ceil((datetime.now() - ticket.entry_time).total_seconds() / 60))
    return {
        "plate_number": ticket.plate_number,
        "slot_id": ticket.slot.slot_id,
        "vehicle_type": ticket.vehicle_type.value,
        "duration_minutes": duration_minutes,
        "amount": fee_for_minutes(duration_minutes, ticket.vehicle_type),
        "rate_tiers": [dict(tier) for tier in rate_tiers[ticket.vehicle_type.value]],
    }


load_data()


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
            with data_lock:
                self.send_json(200, status_payload())
            return
        if path.startswith("/api/quote/"):
            plate_number = path.removeprefix("/api/quote/").strip().upper()
            try:
                with data_lock:
                    self.send_json(200, quote_for(plate_number))
            except ValueError as error:
                self.send_json(404, {"error": str(error)})
            return
        self.serve_static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            payload = self.read_json()
            if path == "/api/history/delete":
                record_ids = payload.get("record_ids")
                if not isinstance(record_ids, list) or not record_ids or any(not isinstance(record_id, str) for record_id in record_ids):
                    raise ValueError("Select at least one checkout record to delete")
                selected_ids = set(record_ids)
                if len(selected_ids) != len(record_ids):
                    raise ValueError("Duplicate checkout record selection")
                with data_lock:
                    records = checkout_history_payload()
                    current_ids = {record["history_id"] for record in records}
                    if not selected_ids.issubset(current_ids):
                        raise ValueError("Some selected records are no longer available. Refresh the history and try again.")
                    previous_history = checkout_history[:]
                    checkout_history[:] = [
                        receipt for receipt, record in zip(checkout_history, records)
                        if record["history_id"] not in selected_ids
                    ]
                    try:
                        save_data()
                    except OSError:
                        checkout_history[:] = previous_history
                        raise
                    self.send_json(200, status_payload())
                return
            if path == "/api/entry":
                plate_number = validate_plate_number(payload.get("plate_number"))
                vehicle_type = VehicleType(str(payload.get("vehicle_type", "")).lower())
                requested_slot_id = str(payload.get("slot_id", "")).strip().upper()
                with data_lock:
                    next_slot = lot.find_available_slot(vehicle_type)
                    if not next_slot:
                        raise ValueError(f"No available slot for {vehicle_type.value}")
                    if requested_slot_id and requested_slot_id != next_slot.slot_id:
                        raise ValueError("The next available bay changed. Review the updated availability and try again.")
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
                plate_number = validate_plate_number(payload.get("plate_number"), allow_bay=True)
                with data_lock:
                    self.send_json(200, quote_for(plate_number))
                return
            if path == "/api/payment":
                plate_number = validate_plate_number(payload.get("plate_number"), allow_bay=True)
                method = str(payload.get("method", "")).strip().lower()
                reference = str(payload.get("reference", "")).strip()
                if method not in {"m-pesa", "card", "cash"}:
                    raise ValueError("Choose M-Pesa, card, or cash")
                if payload.get("confirmed") is not True:
                    raise ValueError("Confirm that payment has been received before checkout")
                if method in {"m-pesa", "card"} and not reference:
                    raise ValueError("Enter the confirmed transaction reference")
                with data_lock:
                    quote = quote_for(plate_number)
                    quoted_amount = payload.get("quoted_amount")
                    if isinstance(quoted_amount, bool) or not isinstance(quoted_amount, (int, float)) or round(quoted_amount, 2) != quote["amount"]:
                        raise ValueError("Fee has changed. Review the updated quote before recording payment.")
                    receipt = lot.vehicle_exit(plate_number)
                    now = datetime.now().astimezone().isoformat(timespec="seconds")
                    receipt.update({
                        "vehicle_type": quote["vehicle_type"],
                        "duration_minutes": quote["duration_minutes"],
                        "amount": quote["amount"],
                        "checked_out_at": now,
                        "paid_at": now,
                        "payment_method": method,
                        "payment_reference": reference or None,
                        "payment_status": "confirmed",
                        "barrier_status": "release_authorized",
                        "rate_snapshot": quote["rate_tiers"],
                        "payment_id": f"PAY-{datetime.now().strftime('%Y%m%d%H%M%S')}-{len(checkout_history) + 1:05d}",
                    })
                    checkout_history.insert(0, receipt)
                    save_data()
                self.send_json(200, {"message": "Payment recorded. Exit release authorized.", "receipt": receipt})
                return
            if path == "/api/rates":
                updated_tiers = validate_rate_tiers(payload.get("rate_tiers"))
                with data_lock:
                    previous_tiers = {vehicle_type: [dict(tier) for tier in tiers] for vehicle_type, tiers in rate_tiers.items()}
                    rate_tiers.clear()
                    rate_tiers.update(updated_tiers)
                    try:
                        save_data()
                    except OSError:
                        rate_tiers.clear()
                        rate_tiers.update(previous_tiers)
                        raise
                self.send_json(200, {"rate_tiers": rate_tiers})
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
        route_pages = {
            "/": "index.html",
            "/movement": "movement/index.html",
            "/register": "register/index.html",
            "/admin": "admin/index.html",
            "/admin/history": "admin/history/index.html",
            "/admin/rates": "admin/rates/index.html",
        }
        relative_path = route_pages.get(path, path.lstrip("/"))
        file_path = (ROOT / relative_path).resolve()
        if file_path.is_dir():
            file_path = file_path / "index.html"
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