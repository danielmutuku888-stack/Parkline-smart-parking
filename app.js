const state = { mode: "entry", data: null };
const $ = (selector) => document.querySelector(selector);
const PARKING_URL = "http://localhost:8765";
if (window.location.origin !== PARKING_URL) {
  window.location.replace(PARKING_URL);
}
const API_BASE = PARKING_URL;
const apiUrl = (path) => `${API_BASE}${path}`;

function setFeedback(message, type = "") {
  const feedback = $("#feedback");
  feedback.textContent = message;
  feedback.className = `feedback ${type}`;
}

function render(data) {
  state.data = data;
  const types = ["car", "motorcycle", "truck"];
  const total = Object.values(data.availability).reduce((sum, item) => sum + item.total, 0);
  const available = Object.values(data.availability).reduce((sum, item) => sum + item.available, 0);
  const occupied = total - available;
  $("#occupied-count").textContent = occupied;
  $("#open-count").textContent = available;
  $("#occupancy-meter").style.width = `${total ? (occupied / total) * 100 : 0}%`;
  types.forEach((type) => {
    const item = data.availability[type];
    $(`#${type}-available`).textContent = item.available;
    $(`#${type}-meter`).style.width = `${item.total ? (item.available / item.total) * 100 : 0}%`;
  });
  $("#ticket-count").textContent = data.active_tickets.length;
  $("#ticket-list").innerHTML = data.active_tickets.length ? data.active_tickets.map((ticket) => `
    <div class="ticket"><strong>${escapeHtml(ticket.plate_number)}</strong><span class="slot">${escapeHtml(ticket.slot_id)}</span><small>${ticket.vehicle_type} · entered ${formatTime(ticket.entry_time)}</small></div>
  `).join("") : '<div class="empty-state">No vehicles are currently parked.</div>';
  $("#checkout-history").innerHTML = data.checkout_history.length ? data.checkout_history.map((receipt) => `
    <tr><td data-label="Plate number"><strong>${escapeHtml(receipt.plate_number)}</strong></td><td data-label="Vehicle type">${escapeHtml(receipt.vehicle_type)}</td><td data-label="Time parked">${escapeHtml(formatDuration(receipt.duration, receipt.hours))}</td><td data-label="Amount paid" class="amount">${Number(receipt.amount).toFixed(2)}</td><td data-label="Checked out">${formatDateTime(receipt.checked_out_at)}</td></tr>
  `).join("") : '<tr><td colspan="5" class="empty-table">No completed checkouts yet.</td></tr>';
  $("#last-updated").textContent = "just now";
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" }[character])); }
function formatTime(value) { return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function formatDateTime(value) { return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function formatDuration(duration, hours) { return `${hours} hour${hours === 1 ? "" : "s"}`; }

async function refresh() {
  try {
    const response = await fetch(apiUrl("/api/status"), { cache: "no-store" });
    if (!response.ok) throw new Error("The parking server returned an error.");
    render(await response.json());
  }
  catch (error) {
    setFeedback("Unable to reach the server. Run: python server.py", "error");
  }
}

$("#parking-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const plateNumber = $("#plate-number").value.trim();
  const endpoint = state.mode === "entry" ? "/api/entry" : "/api/exit";
  const body = state.mode === "entry" ? { plate_number: plateNumber, vehicle_type: $("#vehicle-type").value } : { plate_number: plateNumber };
  const submitButton = event.target.querySelector("button[type='submit']");
  submitButton.disabled = true;
  setFeedback("Saving...", "");
  try {
    const response = await fetch(apiUrl(endpoint), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Request failed");
    setFeedback(state.mode === "entry" ? `${result.message}. Ticket ${result.ticket.ticket_id}` : `Checkout complete. Amount due: ${result.receipt.amount.toFixed(2)}`, "success");
    event.target.reset();
    await refresh();
  } catch (error) {
    setFeedback(error instanceof TypeError ? "Unable to reach the server. Run: python server.py" : error.message, "error");
  }
  finally { submitButton.disabled = false; }
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
refresh();