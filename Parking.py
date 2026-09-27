import json
import math
import uuid
from datetime import datetime
from enum import Enum
from pathlib import Path


class VehicleType(Enum):
    MOTORCYCLE = "motorcycle"
    CAR = "car"
    TRUCK = "truck"


class SlotStatus(Enum):
    AVAILABLE = "available"
    OCCUPIED = "occupied"


PARKING_TIERS = [
    (30, 0.0),
    (120, 50.0),
    (240, 100.0),
    (360, 300.0),
    (None, 500.0),
]

DATA_FILE = Path(__file__).with_name("parking_data.json")


def calculate_parking_fee(duration_minutes):
    minutes = max(0, int(duration_minutes))
    for max_minutes, fee in PARKING_TIERS:
        if max_minutes is None or minutes <= max_minutes:
            return float(fee)
    return float(PARKING_TIERS[-1][1])


class ParkingSlot:
    def __init__(self, slot_id, vehicle_type: VehicleType):
        self.slot_id = slot_id
        self.vehicle_type = vehicle_type
        self.status = SlotStatus.AVAILABLE
        self.ticket = None


class Ticket:
    def __init__(self, plate_number, vehicle_type: VehicleType, slot: ParkingSlot):
        date_code = datetime.now().strftime("%Y%m%d")
        short_code = uuid.uuid4().hex[:4].upper()
        self.ticket_id = f"PK-{slot.slot_id}-{date_code}-{short_code}"
        self.plate_number = plate_number
        self.vehicle_type = vehicle_type
        self.slot = slot
        self.entry_time = datetime.now()
        self.exit_time = None
        self.amount = 0.0


class ParkingLot:
    def __init__(self):
        self.slots = {}
        self.active_tickets = {}

    def add_slot(self, slot_id, vehicle_type: VehicleType):
        self.slots[slot_id] = ParkingSlot(slot_id, vehicle_type)

    def get_availability(self):
        counts = {}
        for slot in self.slots.values():
            c = counts.setdefault(slot.vehicle_type, {"available": 0, "total": 0})
            c["total"] += 1
            if slot.status == SlotStatus.AVAILABLE:
                c["available"] += 1
        return counts

    def find_available_slot(self, vehicle_type: VehicleType):
        for slot in self.slots.values():
            if slot.status == SlotStatus.AVAILABLE and slot.vehicle_type == vehicle_type:
                return slot
        return None

    def vehicle_entry(self, plate_number, vehicle_type: VehicleType):
        if plate_number in self.active_tickets:
            raise ValueError("Vehicle already parked")
        slot = self.find_available_slot(vehicle_type)
        if not slot:
            raise Exception(f"No available slot for {vehicle_type.value}")

        ticket = Ticket(plate_number, vehicle_type, slot)
        slot.status = SlotStatus.OCCUPIED
        slot.ticket = ticket
        self.active_tickets[plate_number] = ticket
        return ticket

    def vehicle_exit(self, plate_number):
        ticket = self.active_tickets.get(plate_number)
        if not ticket:
            raise ValueError("No active ticket found for this vehicle")

        ticket.exit_time = datetime.now()
        duration = ticket.exit_time - ticket.entry_time
        duration_minutes = max(1, math.ceil(duration.total_seconds() / 60))
        ticket.amount = round(calculate_parking_fee(duration_minutes), 2)

        slot = ticket.slot
        slot.status = SlotStatus.AVAILABLE  # increments availability
        slot.ticket = None
        del self.active_tickets[plate_number]

        return {
            "plate_number": plate_number,
            "slot_id": slot.slot_id,
            "duration": str(duration),
            "duration_minutes": duration_minutes,
            "hours": math.ceil(duration_minutes / 60),
            "amount": ticket.amount,
        }


def save_data(lot, checkout_history):
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
    temporary_file = DATA_FILE.with_suffix(".json.tmp")
    temporary_file.write_text(json.dumps(data, indent=2), encoding="utf-8")
    temporary_file.replace(DATA_FILE)


def load_data(lot):
    if not DATA_FILE.exists():
        return []
    try:
        saved_data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        for saved_ticket in saved_data.get("active_tickets", []):
            slot = lot.slots.get(saved_ticket["slot_id"])
            vehicle_type = VehicleType(saved_ticket["vehicle_type"])
            if not slot or slot.status == SlotStatus.OCCUPIED:
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
        return saved_data.get("checkout_history", [])
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"Could not load saved parking data: {error}")
        return []


def display_availability(lot):
    print("\nAvailable slots:")
    for vehicle_type in VehicleType:
        availability = lot.get_availability()[vehicle_type]
        print(
            f"  {vehicle_type.value.title()}: "
            f"{availability['available']}/{availability['total']}"
        )


def read_vehicle_type():
    while True:
        value = input("Vehicle type (car/motorcycle/truck): ").strip().lower()
        for vehicle_type in VehicleType:
            if value == vehicle_type.value:
                return vehicle_type
        print("Invalid vehicle type. Please choose car, motorcycle, or truck.")


if __name__ == "__main__":
    lot = ParkingLot()

    # 100 total slots: 60 car, 30 motorcycle, 10 truck
    for i in range(1, 61):
        lot.add_slot(f"C{i}", VehicleType.CAR)
    for i in range(1, 31):
        lot.add_slot(f"M{i}", VehicleType.MOTORCYCLE)
    for i in range(1, 11):
        lot.add_slot(f"T{i}", VehicleType.TRUCK)

    checkout_history = load_data(lot)
    save_data(lot, checkout_history)

    print("Smart Parking System")
    while True:
        print("\n1. Vehicle entry")
        print("2. Vehicle checkout")
        print("3. Check available slots")
        print("4. Exit")
        choice = input("Choose an option: ").strip()

        if choice == "1":
            plate_number = input("Vehicle plate number: ").strip().upper()
            vehicle_type = read_vehicle_type()
            try:
                ticket = lot.vehicle_entry(plate_number, vehicle_type)
                save_data(lot, checkout_history)
                print(f"Plate number recorded as: {plate_number}")
                print(f"Vehicle parked in slot {ticket.slot.slot_id}.")
                print(f"Ticket ID: {ticket.ticket_id}")
            except Exception as error:
                print(f"Entry failed: {error}")
        elif choice == "2":
            plate_number = input("Vehicle plate number: ").strip().upper()
            try:
                receipt = lot.vehicle_exit(plate_number)
                checkout_history.insert(0, receipt)
                save_data(lot, checkout_history)
                print(f"Vehicle checked out from slot {receipt['slot_id']}.")
                print(f"Parking time: {receipt['hours']} hour(s)")
                print(f"Amount due: {receipt['amount']:.2f}")
            except ValueError as error:
                print(f"Checkout failed: {error}")
        elif choice == "3":
            display_availability(lot)
        elif choice == "4":
            print("Goodbye.")
            break
        else:
            print("Invalid option. Please choose 1, 2, 3, or 4.")
