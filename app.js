const STORAGE_KEY = "parkline-smart-parking-data";
const RATES = { motorcycle: 50, car: 100, truck: 120 };
const CAPACITY = { car: 60, motorcycle: 30, truck: 10 };
const state = { mode: "entry", data: null };
const $ = (selector) => document.querySelector(selector);

function createEmptyData() {
  return { active_tickets: [], checkout_history: [] };
}

function loadData() {
  try {
    const savedData = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (savedData && Array.isArray(savedData.active_tickets) && Array.isArray(savedData.checkout_history)) {
      return savedData;
    }
  } catch (error) {
    console.warn("Could not load saved parking data.", error);
  }
  return createEmptyData();
}

function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function availability(data) {
  return Object.fromEntries(Object.entries(CAPACITY).map(([type, total]) => [type, {
      total,
      available: total - data.active_tickets.filter((ticket) => ticket.vehicle_type === type).length,
    }]));
}

function setFeedback(message, type = "") {
  const feedback = $("#feedback");
  feedback.textContent = message;
  feedback.className = `feedback ${type}`;
}

function render(data) {
  state.data = data;
  const currentAvailability = availability(data);
  const total = Object.values(currentAvailability).reduce((sum, item) => sum + item.total, 0);
  const available = Object.values(currentAvailability).reduce((sum, item) => sum + item.available, 0);
  const occupied = total - available;
  $("#occupied-count").textContent = occupied;
  $("#open-count").textContent = available;
  $("#occupancy-meter").style.width = `${total ? (occupied / total) * 100 : 0}%`;
  Object.keys(CAPACITY).forEach((type) => {
    const item = currentAvailability[type];
    $(`#${type}-available`).textContent = item.available;
    $(`#${type}-meter`).style.width = `${(item.available / item.total) * 100}%`;
  });
  $("#ticket-count").textContent = data.active_tickets.length;
  $("#ticket-list").innerHTML = data.active_tickets.length ? data.active_tickets.map((ticket) => `
    <div class="ticket"><strong>${escapeHtml(ticket.plate_number)}</strong><span class="slot">${escapeHtml(ticket.slot_id)}</span><small>${ticket.vehicle_type} · entered ${formatTime(ticket.entry_time)}</small></div>
  `).join("") : '<div class="empty-state">No vehicles are currently parked.</div>';
  $("#checkout-history").innerHTML = data.checkout_history.length ? data.checkout_history.map((receipt) => `
    <tr><td data-label="Plate number"><strong>${escapeHtml(receipt.plate_number)}</strong></td><td data-label="Vehicle type">${escapeHtml(receipt.vehicle_type)}</td><td data-label="Time parked">${escapeHtml(formatDuration(receipt.hours))}</td><td data-label="Amount paid" class="amount">${Number(receipt.amount).toFixed(2)}</td><td data-label="Checked out">${formatDateTime(receipt.checked_out_at)}</td></tr>
  `).join("") : '<tr><td colspan="5" class="empty-table">No completed checkouts yet.</td></tr>';
  $("#last-updated").textContent = "just now";
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" }[character])); }
function formatTime(value) { return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function formatDateTime(value) { return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function formatDuration(hours) { return `${hours} hour${hours === 1 ? "" : "s"}`; }
function createTicketId(slotId) {
  const randomCode = window.crypto?.randomUUID ? crypto.randomUUID().slice(0, 4).toUpperCase() : Math.random().toString(16).slice(2, 6).toUpperCase();
  const dateCode = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `PK-${slotId}-${dateCode}-${randomCode}`;
}

function findSlot(data, vehicleType) {
  const prefix = { car: "C", motorcycle: "M", truck: "T" }[vehicleType];
  const occupiedSlots = new Set(data.active_tickets.map((ticket) => ticket.slot_id));
  for (let index = 1; index <= CAPACITY[vehicleType]; index += 1) {
    const slotId = `${prefix}${index}`;
    if (!occupiedSlots.has(slotId)) return slotId;
  }
  return null;
}

function enterVehicle(data, plateNumber, vehicleType) {
  if (data.active_tickets.some((ticket) => ticket.plate_number === plateNumber)) throw new Error("Vehicle already parked");
  const slotId = findSlot(data, vehicleType);
  if (!slotId) throw new Error(`No available slot for ${vehicleType}`);
  const entryTime = new Date().toISOString();
  const ticket = { plate_number: plateNumber, vehicle_type: vehicleType, slot_id: slotId, ticket_id: createTicketId(slotId), entry_time: entryTime };
  data.active_tickets.push(ticket);
  return ticket;
}

function exitVehicle(data, plateNumber) {
  const ticketIndex = data.active_tickets.findIndex((item) => item.plate_number === plateNumber);
  if (ticketIndex < 0) throw new Error("No active ticket found for this vehicle");
  const ticket = data.active_tickets[ticketIndex];
  const elapsedHours = Math.ceil((Date.now() - new Date(ticket.entry_time).getTime()) / 3600000) || 1;
  const receipt = {
    plate_number: plateNumber,
    slot_id: ticket.slot_id,
    duration: `${elapsedHours}:00:00`,
    hours: elapsedHours,
    amount: elapsedHours * RATES[ticket.vehicle_type],
    vehicle_type: ticket.vehicle_type,
    checked_out_at: new Date().toISOString(),
  };
  data.active_tickets.splice(ticketIndex, 1);
  data.checkout_history.unshift(receipt);
  return receipt;
}

$("#parking-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const plateNumber = $("#plate-number").value.trim().toUpperCase();
  const vehicleType = $("#vehicle-type").value;
  const submitButton = event.target.querySelector("button[type='submit']");
  submitButton.disabled = true;
  setFeedback("Saving...", "");
  try {
    const data = state.data || loadData();
    if (!plateNumber) throw new Error("Plate number is required");
    if (state.mode === "entry") {
      const ticket = enterVehicle(data, plateNumber, vehicleType);
      saveData(data);
      setFeedback(`Vehicle parked in slot ${ticket.slot_id}. Ticket ${ticket.ticket_id}`, "success");
    } else {
      const receipt = exitVehicle(data, plateNumber);
      saveData(data);
      setFeedback(`Checkout complete. Amount due: ${receipt.amount.toFixed(2)}`, "success");
    }
    event.target.reset();
    render(data);
  } catch (error) {
    setFeedback(error.message, "error");
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
  state.mode = tab.dataset.mode;
  document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
  const entryMode = state.mode === "entry";
  $("#vehicle-type").hidden = !entryMode;
  $("#vehicle-type-label").hidden = !entryMode;
  $("#submit-label").textContent = entryMode ? "Assign a space" : "Complete checkout";
  setFeedback();
}));

$("#today").textContent = new Date().toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
setInterval(() => { $("#clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }, 1000);
render(loadData());


