const state = { mode: "entry", quote: null, ratesInitialized: false, submitting: false };
const $ = (selector) => document.querySelector(selector);
const currency = new Intl.NumberFormat("en-KE", { style: "currency", currency: "KES", maximumFractionDigits: 2 });
const API_BASE_URL = "http://localhost:8765";
let checkoutHistory = [];
let selectedHistoryIds = new Set();
let parkingState = null;
const statusChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("parkline-live-status");
const setText = (selector, value) => {
  const element = $(selector);
  if (element) element.textContent = value;
};

function historyRecordKeys(records) {
  const occurrences = new Map();
  return records.map((receipt) => {
    if (receipt.history_id) return receipt.history_id;
    const fingerprint = JSON.stringify(Object.entries(receipt).sort(([left], [right]) => left.localeCompare(right)));
    const occurrence = (occurrences.get(fingerprint) || 0) + 1;
    occurrences.set(fingerprint, occurrence);
    return `legacy-${fingerprint}-${occurrence}`;
  });
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Parking server returned a non-JSON response (${response.status}). Make sure the Python server is running at ${API_BASE_URL}.`);
  }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

statusChannel?.addEventListener("message", (event) => {
  if (event.data?.availability) render(event.data);
});

if (!statusChannel) {
  window.addEventListener("storage", (event) => {
    if (event.key !== "parkline-live-status" || !event.newValue) return;
    try {
      const data = JSON.parse(event.newValue);
      if (data?.availability) render(data);
    } catch {
      return;
    }
  });
}

async function loadSharedShell() {
  const response = await fetch("/partials/site-shell.html");
  if (!response.ok) throw new Error("Could not load the shared site navigation.");
  const template = document.createElement("template");
  template.innerHTML = await response.text();
  ["header", "nav", "footer"].forEach((region) => {
    const host = $(`#shared-${region}`);
    const content = template.content.querySelector(`[data-shell-region="${region}"]`);
    if (host && content) host.replaceWith(content.cloneNode(true));
  });

  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const currentPath = path === "/index.html" ? "/" : path;
  const adminMenu = $(".admin-menu");
  if (adminMenu && currentPath.startsWith("/admin")) adminMenu.open = true;
  document.querySelectorAll(".side-nav [data-route]").forEach((link) => {
    const route = link.dataset.route;
    const active = route === "/" ? currentPath === "/" : currentPath.startsWith(route);
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function setFeedback(message, type = "") {
  const feedback = $("#feedback");
  if (!feedback) return;
  feedback.textContent = message;
  feedback.className = `feedback ${type}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" }[character]));
}

function formatTime(value) { return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function formatDateTime(value) { return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function formatDuration(minutes) {
  const totalMinutes = Math.max(0, Number(minutes) || 0);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours && mins) return `${hours}h ${mins}m`;
  if (hours) return `${hours}h`;
  return `${mins}m`;
}

function renderRates(tierGroups) {
  const vehicleTypes = ["car", "motorcycle", "truck"];
  const groups = Array.isArray(tierGroups)
    ? Object.fromEntries(vehicleTypes.map((vehicleType) => [vehicleType, tierGroups]))
    : tierGroups || {};
  vehicleTypes.forEach((vehicleType) => {
    (groups[vehicleType] || []).forEach((tier, index) => {
      const input = $(`[name="rate-${vehicleType}-${index}"]`);
      if (input) input.value = tier.amount;
    });
  });
  state.ratesInitialized = true;
}

function normalizeSlots(data) {
  if (Array.isArray(data.slots)) return data.slots;
  const prefixes = { car: "C", motorcycle: "M", truck: "T" };
  const ticketsBySlot = new Map((data.active_tickets || []).map((ticket) => [ticket.slot_id, ticket]));
  return Object.entries(data.availability || {}).flatMap(([vehicleType, counts]) => {
    const prefix = prefixes[vehicleType];
    if (!prefix) return [];
    return Array.from({ length: Number(counts.total) || 0 }, (_, index) => {
      const slotId = `${prefix}${index + 1}`;
      const ticket = ticketsBySlot.get(slotId);
      return {
        slot_id: slotId,
        vehicle_type: vehicleType,
        status: ticket ? "occupied" : "available",
        plate_number: ticket?.plate_number || null,
        entry_time: ticket?.entry_time || null,
      };
    });
  });
}

function getRegisterView() {
  const requestedView = new URLSearchParams(window.location.search).get("view");
  if (requestedView === "table" || requestedView === "grid") return requestedView;
  try {
    return localStorage.getItem("parkline-register-view") === "grid" ? "grid" : "table";
  } catch {
    return "table";
  }
}

function applyRegisterView(view = getRegisterView()) {
  const showGrid = view === "grid";
  const heading = $("#slot-grid-heading");
  const grid = $("#slot-grid-view");
  const table = $("#register-table-view");
  if (heading) heading.hidden = !showGrid;
  if (grid) grid.hidden = !showGrid;
  if (table) table.hidden = showGrid;
  document.querySelectorAll("[data-register-view]").forEach((button) => {
    const active = button.dataset.registerView === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function renderRegister() {
  const slotTable = $("#slot-register");
  if (!slotTable || !parkingState) return;
  const queryType = new URLSearchParams(window.location.search).get("type");
  const requestedType = ["car", "motorcycle", "truck"].includes(queryType) ? queryType : "";
  const slots = parkingState.slots.filter((slot) => !requestedType || slot.vehicle_type === requestedType);
  const filter = $("#register-filter");
  if (filter) filter.value = requestedType;
  setText("#register-count", slots.length);
  const occupiedCount = slots.filter((slot) => slot.status === "occupied").length;
  const availableCount = slots.filter((slot) => slot.status === "available").length;
  setText("#register-occupied", occupiedCount);
  setText("#register-available", availableCount);
  setText("#slot-grid-total-count", slots.length);
  slotTable.innerHTML = slots.length ? slots.map((slot) => `
    <tr>
      <td><strong>${escapeHtml(slot.slot_id)}</strong></td>
      <td>${escapeHtml(slot.vehicle_type)}</td>
      <td><span class="slot-status ${slot.status === "occupied" ? "occupied" : "available"}">${slot.status === "occupied" ? "Occupied" : "Free"}</span></td>
      <td>${slot.plate_number ? escapeHtml(slot.plate_number) : "-"}</td>
      <td>${slot.entry_time ? formatDateTime(slot.entry_time) : "-"}</td>
    </tr>
  `).join("") : '<tr><td colspan="5" class="empty-table">No parking slots match this filter.</td></tr>';
  const slotGrid = $("#slot-grid");
  if (slotGrid) {
    slotGrid.innerHTML = slots.length ? slots.map((slot) => {
      const occupied = slot.status === "occupied";
      const status = occupied ? "Occupied" : "Free";
      return `<article class="slot-card ${occupied ? "occupied" : "free"}" aria-label="${escapeHtml(slot.slot_id)}, ${status}">
        <strong>${escapeHtml(slot.slot_id)}</strong><span>${status}</span>
      </article>`;
    }).join("") : '<p class="empty-state">No parking slots match this filter.</p>';
  }
  applyRegisterView();
}

function renderCheckoutPicker() {
  const list = $("#checkout-picker-list");
  if (!list || !parkingState) return;
  const search = $("#checkout-search")?.value.trim().toLowerCase() || "";
  const parkedSlots = parkingState.slots.filter((slot) => slot.status === "occupied");
  const matches = parkedSlots.filter((slot) => `${slot.plate_number || ""} ${slot.slot_id} ${slot.vehicle_type}`.toLowerCase().includes(search));
  if (!parkedSlots.length) {
    list.innerHTML = '<p class="empty-state">No vehicles are currently parked.</p>';
    return;
  }
  if (!matches.length) {
    list.innerHTML = '<p class="empty-state">No parked vehicles match this search.</p>';
    return;
  }
  list.innerHTML = matches.map((slot) => {
    const duration = slot.entry_time ? Math.max(1, Math.ceil((Date.now() - new Date(slot.entry_time).getTime()) / 60000)) : null;
    const parkedTime = duration === null ? "Time unavailable" : `${formatDuration(duration)} parked`;
    return `<button class="checkout-choice" type="button" data-checkout-plate="${escapeHtml(slot.plate_number || "")}">
      <span><strong>${escapeHtml(slot.plate_number || "Plate unavailable")}</strong><small>${escapeHtml(slot.slot_id)} · ${escapeHtml(slot.vehicle_type)} · ${parkedTime}</small></span>
      <span class="choice-action">Select</span>
    </button>`;
  }).join("");
}

function render(data) {
  parkingState = { ...data, slots: normalizeSlots(data) };
  checkoutHistory = parkingState.checkout_history || [];
  const historyKeys = historyRecordKeys(checkoutHistory);
  const historyIds = new Set(historyKeys);
  selectedHistoryIds = new Set([...selectedHistoryIds].filter((historyId) => historyIds.has(historyId)));
  const availability = parkingState.availability || {};
  const capacity = Object.values(availability);
  const total = capacity.reduce((sum, item) => sum + item.total, 0);
  const available = capacity.reduce((sum, item) => sum + item.available, 0);
  const occupied = total - available;
  setText("#occupied-count", occupied);
  setText("#open-count", available);
  const occupancyMeter = $("#occupancy-meter");
  if (occupancyMeter) occupancyMeter.style.width = `${total ? (occupied / total) * 100 : 0}%`;
  Object.entries(availability).forEach(([type, item]) => {
    setText(`#${type}-available`, item.available);
    setText(`#${type}-total`, item.total);
    const meter = $(`#${type}-meter`);
    if (meter) meter.style.width = `${item.total ? (item.available / item.total) * 100 : 0}%`;
  });
  const activeTickets = parkingState.active_tickets || [];
  setText("#ticket-count", activeTickets.length);
  const ticketList = $("#ticket-list");
  if (ticketList) {
    ticketList.innerHTML = activeTickets.length ? activeTickets.map((ticket) => `
      <div class="ticket"><strong>${escapeHtml(ticket.plate_number)}</strong><span class="slot">${escapeHtml(ticket.slot_id)}</span><small>${escapeHtml(ticket.vehicle_type)} · entered ${formatTime(ticket.entry_time)}</small></div>
    `).join("") : '<div class="empty-state">No vehicles are currently parked.</div>';
  }

  renderRegister();
  renderCheckoutPicker();
  updateEntryAvailability();

  const today = new Date().toLocaleDateString();
  const todayReceipts = checkoutHistory.filter((receipt) => new Date(receipt.paid_at || receipt.checked_out_at).toLocaleDateString() === today);
  setText("#today-revenue", currency.format(todayReceipts.reduce((sum, receipt) => sum + Number(receipt.amount || 0), 0)));
  [["m-pesa", "mpesa-total"], ["card", "card-total"], ["cash", "cash-total"]].forEach(([method, selector]) => {
    const totalForMethod = todayReceipts.filter((receipt) => receipt.payment_method === method).reduce((sum, receipt) => sum + Number(receipt.amount || 0), 0);
    setText(`#${selector}`, currency.format(totalForMethod));
  });
  const checkoutTable = $("#checkout-history");
  if (checkoutTable) {
    checkoutTable.innerHTML = checkoutHistory.length ? checkoutHistory.map((receipt, index) => {
      const historyId = historyKeys[index];
      const selected = selectedHistoryIds.has(historyId);
      return `
      <tr class="history-record-row${selected ? " selected" : ""}" data-history-id="${escapeHtml(historyId)}" tabindex="0" aria-selected="${selected}"><td data-label="Select"><input class="history-record-select" type="checkbox" value="${escapeHtml(historyId)}" aria-label="Select receipt ${escapeHtml(receipt.payment_id || receipt.plate_number || "legacy")}"${selected ? " checked" : ""}></td><td data-label="Receipt"><strong>${escapeHtml(receipt.payment_id || "Legacy")}</strong></td><td data-label="Plate / bay"><strong>${escapeHtml(receipt.plate_number)}</strong><br>${escapeHtml(receipt.slot_id || "-")}</td><td data-label="Duration">${escapeHtml(formatDuration(receipt.duration_minutes ?? (receipt.hours || 0) * 60))}</td><td data-label="Method / reference">${escapeHtml(receipt.payment_method || "Legacy")}<br>${escapeHtml(receipt.payment_reference || "-")}</td><td data-label="Amount" class="amount">${currency.format(Number(receipt.amount))}</td><td data-label="Paid at">${formatDateTime(receipt.paid_at || receipt.checked_out_at)}</td></tr>
      `;
    }).join("") : '<tr><td colspan="7" class="empty-table">No completed checkouts yet.</td></tr>';
    updateHistorySelection();
  }
  if (!state.ratesInitialized && $("[name='rate-car-0']")) renderRates(parkingState.rate_tiers || []);
  setText("#last-updated", new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function downloadPaymentRecords(records, filenamePrefix) {
  const columns = ["Receipt ID", "Paid at", "Plate number", "Bay", "Vehicle type", "Duration minutes", "Payment method", "Payment reference", "Payment status", "Amount KES"];
  const rows = records.map((receipt) => [
    receipt.payment_id,
    receipt.paid_at || receipt.checked_out_at,
    receipt.plate_number,
    receipt.slot_id,
    receipt.vehicle_type,
    receipt.duration_minutes,
    receipt.payment_method,
    receipt.payment_reference,
    receipt.payment_status || "legacy",
    Number(receipt.amount || 0).toFixed(2),
  ]);
  const csv = [columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

$("#export-payments")?.addEventListener("click", () => {
  downloadPaymentRecords(checkoutHistory, "parkline-payments");
});
$("#export-selected-payments")?.addEventListener("click", () => {
  const historyKeys = historyRecordKeys(checkoutHistory);
  const selectedRecords = checkoutHistory.filter((receipt, index) => selectedHistoryIds.has(historyKeys[index]));
  if (selectedRecords.length) downloadPaymentRecords(selectedRecords, "parkline-selected-payments");
});

function updateHistorySelection() {
  const checkboxes = Array.from(document.querySelectorAll(".history-record-select"));
  const checked = checkboxes.filter((checkbox) => checkbox.checked);
  selectedHistoryIds = new Set(checked.map((checkbox) => checkbox.value));
  checkboxes.forEach((checkbox) => {
    const row = checkbox.closest(".history-record-row");
    row?.classList.toggle("selected", checkbox.checked);
    row?.setAttribute("aria-selected", String(checkbox.checked));
  });
  const selectAll = $("#select-all-history");
  if (selectAll) {
    selectAll.disabled = checkboxes.length === 0;
    selectAll.checked = checkboxes.length > 0 && checked.length === checkboxes.length;
    selectAll.indeterminate = checked.length > 0 && checked.length < checkboxes.length;
  }
  setText("#selected-history-count", `${checked.length} selected`);
  const exportSelectedButton = $("#export-selected-payments");
  if (exportSelectedButton) exportSelectedButton.disabled = checked.length === 0;
  const deleteButton = $("#delete-selected-history");
  if (deleteButton) deleteButton.disabled = checked.length === 0;
}

function toggleHistoryRow(row) {
  const checkbox = row.querySelector(".history-record-select");
  if (!checkbox) return;
  checkbox.checked = !checkbox.checked;
  updateHistorySelection();
}

$("#checkout-history")?.addEventListener("click", (event) => {
  if (event.target.closest("input, button, a, select, textarea, label")) return;
  const row = event.target.closest(".history-record-row");
  if (row) toggleHistoryRow(row);
});
$("#checkout-history")?.addEventListener("keydown", (event) => {
  if (!event.target.matches(".history-record-row") || !["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  toggleHistoryRow(event.target);
});
$("#checkout-history")?.addEventListener("change", (event) => {
  if (event.target.matches(".history-record-select")) updateHistorySelection();
});
$("#select-all-history")?.addEventListener("change", (event) => {
  document.querySelectorAll(".history-record-select").forEach((checkbox) => {
    checkbox.checked = event.currentTarget.checked;
  });
  updateHistorySelection();
});
$("#delete-selected-history")?.addEventListener("click", async () => {
  const recordIds = [...selectedHistoryIds];
  if (!recordIds.length) return;
  const confirmed = window.confirm(`Delete ${recordIds.length} selected checkout record${recordIds.length === 1 ? "" : "s"}? This cannot be undone. Active parking sessions will not be affected.`);
  if (!confirmed) return;
  const button = $("#delete-selected-history");
  const feedback = $("#history-feedback");
  button.disabled = true;
  feedback.className = "feedback";
  feedback.textContent = "Deleting selected checkout records...";
  try {
    const data = await request("/api/history/delete", { method: "POST", body: JSON.stringify({ record_ids: recordIds }) });
    render(data);
    if (statusChannel) statusChannel.postMessage(data);
    else {
      try {
        localStorage.setItem("parkline-live-status", JSON.stringify(data));
      } catch {}
    }
    feedback.className = "feedback success";
    feedback.textContent = `${recordIds.length} checkout record${recordIds.length === 1 ? "" : "s"} deleted.`;
  } catch (error) {
    feedback.className = "feedback error";
    feedback.textContent = error.message;
  } finally {
    updateHistorySelection();
  }
});

async function refreshStatus() {
  try {
    const data = await request("/api/status");
    render(data);
    if (statusChannel) statusChannel.postMessage(data);
    else {
      try {
        localStorage.setItem("parkline-live-status", JSON.stringify(data));
      } catch {}
    }
    setText("#connection-state", "Live operations");
    $(".pulse")?.classList.remove("offline");
  } catch (error) {
    setText("#connection-state", "Offline");
    $(".pulse")?.classList.add("offline");
    if (!parkingState) {
      const message = "Parking data could not be loaded. Check that the parking server is running.";
      const slotTable = $("#slot-register");
      if (slotTable) slotTable.innerHTML = `<tr><td colspan="5" class="empty-table error-state">${message}</td></tr>`;
      const picker = $("#checkout-picker-list");
      if (picker) picker.innerHTML = `<p class="error-state">${message}</p>`;
      const history = $("#checkout-history");
      if (history) history.innerHTML = `<tr><td colspan="6" class="empty-table error-state">${message}</td></tr>`;
      setText("#register-count", "-");
      setText("#register-available", "-");
      setText("#register-occupied", "-");
    }
  }
}

function updateEntryAvailability() {
  const vehicleSelect = $("#vehicle-type");
  if (!vehicleSelect || !parkingState) return;
  const vehicleNames = { car: "Cars", motorcycle: "Motorcycles", truck: "Trucks" };
  const nextBay = parkingState.slots.find((slot) => slot.vehicle_type === vehicleSelect.value && slot.status === "available")?.slot_id;
  setText("#next-bay", nextBay ? `Next bay: ${nextBay}` : "No spaces available");
  Array.from(vehicleSelect.options).forEach((option) => {
    const available = Number(parkingState.availability[option.value]?.available || 0);
    option.disabled = available === 0;
    option.textContent = `${vehicleNames[option.value]}${available === 0 ? " · Lot full" : ""}`;
  });
  const currentAvailable = Number(parkingState.availability[vehicleSelect.value]?.available || 0);
  const full = currentAvailable === 0;
  const notice = $("#capacity-notice");
  if (notice) {
    notice.hidden = state.mode !== "entry";
    notice.textContent = state.mode === "entry" && full
      ? `Lot full for ${vehicleNames[vehicleSelect.value].toLowerCase()}. Choose another vehicle type.`
      : state.mode === "entry" ? `${currentAvailable} spaces available for ${vehicleNames[vehicleSelect.value].toLowerCase()}.` : "";
    notice.classList.toggle("error", state.mode === "entry" && full);
  }
  const submitButton = $("#parking-form button[type='submit']");
  if (submitButton) submitButton.disabled = state.submitting || (state.mode === "entry" && full);
}

function setPaymentFields() {
  const needsReference = $("#payment-method").value !== "cash";
  $("#payment-reference-wrap").hidden = !needsReference;
  $("#payment-reference").required = needsReference;
}

async function getQuote(plateNumber) {
  state.quote = await request("/api/exit", { method: "POST", body: JSON.stringify({ plate_number: plateNumber }) });
  $("#plate-number").value = state.quote.plate_number;
  $("#checkout-details").hidden = false;
  $("#payment-confirmed").required = true;
  $("#payment-confirmed").checked = false;
  $("#quoted-fee").textContent = currency.format(state.quote.amount);
  $("#quote-summary").textContent = `${formatDuration(state.quote.duration_minutes)} parked · Bay ${state.quote.slot_id}`;
  $("#submit-label").textContent = "Confirm payment & authorize exit";
  setPaymentFields();
}

function isValidPlate(value, allowBay = false) {
  return /^[A-Z0-9][A-Z0-9 -]{0,10}[A-Z0-9]$/.test(value) || (allowBay && /^[CMT]\d{1,2}$/.test(value));
}

$("#parking-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const plateNumber = $("#plate-number").value.trim().toUpperCase();
  const vehicleType = $("#vehicle-type").value;
  const nextBay = parkingState?.slots.find((slot) => slot.vehicle_type === vehicleType && slot.status === "available");
  const submitButton = form.querySelector("button[type='submit']");
  if (!plateNumber || !isValidPlate(plateNumber, state.mode === "exit")) {
    setFeedback(`Enter a valid plate number${state.mode === "exit" ? " or bay ID" : ""}.`, "error");
    $("#plate-number").focus();
    return;
  }
  if (state.mode === "entry") {
    if ((parkingState?.active_tickets || []).some((ticket) => ticket.plate_number.toUpperCase() === plateNumber)) {
      setFeedback("This vehicle is already checked in.", "error");
      return;
    }
    if (Number(parkingState?.availability[vehicleType]?.available || 0) === 0) {
      setFeedback("Lot full for this vehicle type. Choose another type.", "error");
      updateEntryAvailability();
      return;
    }
    if (!nextBay) {
      setFeedback("No free bay is available for this vehicle type. Refresh status and try again.", "error");
      return;
    }
  }
  state.submitting = true;
  submitButton.disabled = true;
  updateEntryAvailability();
  setFeedback(state.mode === "entry" ? "Recording entry..." : state.quote ? "Recording confirmed payment..." : "Calculating fee...", "");
  try {
    if (state.mode === "entry") {
      const result = await request("/api/entry", { method: "POST", body: JSON.stringify({ plate_number: plateNumber, vehicle_type: vehicleType, slot_id: nextBay.slot_id }) });
      setFeedback(`${result.message}. Ticket ${result.ticket.ticket_id}`, "success");
      form.reset();
      await refreshStatus();
    } else if (!state.quote) {
      await getQuote(plateNumber);
      setFeedback("Review the fee, collect payment, then confirm it here.", "success");
    } else {
      const result = await request("/api/payment", {
        method: "POST",
        body: JSON.stringify({
          plate_number: state.quote.plate_number || plateNumber,
          method: $("#payment-method").value,
          reference: $("#payment-reference").value.trim(),
          confirmed: $("#payment-confirmed").checked,
          quoted_amount: state.quote.amount,
        }),
      });
      setFeedback(`${result.message} ${result.receipt.payment_id} · ${currency.format(result.receipt.amount)}.`, "success");
      state.quote = null;
      form.reset();
      $("#checkout-details").hidden = true;
      $("#payment-confirmed").required = false;
      $("#payment-reference").required = false;
      $("#submit-label").textContent = "Review fee";
      await refreshStatus();
    }
  } catch (error) {
    setFeedback(error.message, "error");
    if (state.mode === "exit" && state.quote && error.message.includes("Fee has changed")) {
      await getQuote(plateNumber);
      $("#payment-confirmed").checked = false;
    }
  } finally {
    state.submitting = false;
    updateEntryAvailability();
  }
});

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
  state.mode = tab.dataset.mode;
  state.quote = null;
  document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
  const entryMode = state.mode === "entry";
  $("#checkout-picker").hidden = entryMode;
  $("#vehicle-type").hidden = !entryMode;
  $("#vehicle-type-label").hidden = !entryMode;
  $("#capacity-notice").hidden = !entryMode;
  $("#checkout-details").hidden = true;
  $("#payment-confirmed").required = false;
  $("#payment-reference").required = false;
  $("#submit-label").textContent = entryMode ? "Assign a space" : "Review fee";
  setFeedback();
  updateEntryAvailability();
}));

$("#payment-method")?.addEventListener("change", setPaymentFields);
$("#vehicle-type")?.addEventListener("change", updateEntryAvailability);
$("#checkout-search")?.addEventListener("input", renderCheckoutPicker);
$("#checkout-picker-list")?.addEventListener("click", async (event) => {
  const choice = event.target.closest("[data-checkout-plate]");
  if (!choice) return;
  const plateNumber = choice.dataset.checkoutPlate;
  if (!plateNumber) {
    setFeedback("This vehicle has no plate number available. Use manual lookup.", "error");
    return;
  }
  $("#plate-number").value = plateNumber;
  setFeedback("Loading parking fee...", "");
  try {
    await getQuote(plateNumber);
    setFeedback("Vehicle selected. Review the fee, collect payment, then confirm it here.", "success");
  } catch (error) {
    setFeedback(error.message, "error");
  }
});
$("#plate-number")?.addEventListener("input", (event) => {
  if (state.mode !== "exit" || !state.quote || event.currentTarget.value.trim().toUpperCase() === state.quote.plate_number) return;
  state.quote = null;
  $("#checkout-details").hidden = true;
  $("#payment-confirmed").required = false;
  $("#payment-reference").required = false;
  $("#submit-label").textContent = "Review fee";
});
$("#register-filter")?.addEventListener("change", (event) => {
  const url = new URL(window.location.href);
  if (event.currentTarget.value) url.searchParams.set("type", event.currentTarget.value);
  else url.searchParams.delete("type");
  window.location.assign(`/register${url.search}`);
});
document.querySelectorAll("[data-register-view]").forEach((button) => button.addEventListener("click", () => {
  const view = button.dataset.registerView;
  const url = new URL(window.location.href);
  url.searchParams.set("view", view);
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  try {
    localStorage.setItem("parkline-register-view", view);
  } catch {
    // The selected view still applies for this page.
  }
  applyRegisterView(view);
}));
$("#rate-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  $("#rate-feedback").textContent = "Saving rates...";
  try {
    const rateTiers = Object.fromEntries(["car", "motorcycle", "truck"].map((vehicleType) => [
      vehicleType,
      [30, 120, 240, 360, null].map((maxMinutes, index) => ({
        max_minutes: maxMinutes,
        amount: Number(event.currentTarget.elements[`rate-${vehicleType}-${index}`].value),
      })),
    ]));
    const result = await request("/api/rates", { method: "POST", body: JSON.stringify({ rate_tiers: rateTiers }) });
    renderRates(result.rate_tiers);
    $("#rate-feedback").textContent = "Rates saved and active.";
    await refreshStatus();
  } catch (error) {
    $("#rate-feedback").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

setText("#today", new Date().toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }));
setInterval(() => { setText("#clock", new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })); }, 1000);
loadSharedShell().then(() => {
  refreshStatus();
  setInterval(refreshStatus, 5000);
}).catch((error) => {
  console.error(error);
  setText("#connection-state", "Offline");
});


