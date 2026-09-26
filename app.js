const state = { mode: "entry", quote: null, ratesInitialized: false };
const $ = (selector) => document.querySelector(selector);
const currency = new Intl.NumberFormat("en-KE", { style: "currency", currency: "KES", maximumFractionDigits: 2 });

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}

function setFeedback(message, type = "") {
  $("#feedback").textContent = message;
  $("#feedback").className = `feedback ${type}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" }[character]));
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

function renderRates(tiers) {
  tiers.forEach((tier, index) => {
    $(`[name="rate-${index}"]`).value = tier.amount;
  });
  state.ratesInitialized = true;
}

function render(data) {
  const capacity = Object.values(data.availability);
  const total = capacity.reduce((sum, item) => sum + item.total, 0);
  const available = capacity.reduce((sum, item) => sum + item.available, 0);
  const occupied = total - available;
  $("#occupied-count").textContent = occupied;
  $("#open-count").textContent = available;
  $("#occupancy-meter").style.width = `${total ? (occupied / total) * 100 : 0}%`;
  Object.entries(data.availability).forEach(([type, item]) => {
    $(`#${type}-available`).textContent = item.available;
    $(`#${type}-meter`).style.width = `${item.total ? (item.available / item.total) * 100 : 0}%`;
  });
  $("#ticket-count").textContent = data.active_tickets.length;
  $("#ticket-list").innerHTML = data.active_tickets.length ? data.active_tickets.map((ticket) => `
    <div class="ticket"><strong>${escapeHtml(ticket.plate_number)}</strong><span class="slot">${escapeHtml(ticket.slot_id)}</span><small>${escapeHtml(ticket.vehicle_type)} · entered ${formatTime(ticket.entry_time)}</small></div>
  `).join("") : '<div class="empty-state">No vehicles are currently parked.</div>';

  const today = new Date().toLocaleDateString();
  const todayReceipts = data.checkout_history.filter((receipt) => new Date(receipt.paid_at || receipt.checked_out_at).toLocaleDateString() === today);
  $("#today-revenue").textContent = currency.format(todayReceipts.reduce((sum, receipt) => sum + Number(receipt.amount || 0), 0));
  [["m-pesa", "mpesa-total"], ["card", "card-total"], ["cash", "cash-total"]].forEach(([method, selector]) => {
    const totalForMethod = todayReceipts.filter((receipt) => receipt.payment_method === method).reduce((sum, receipt) => sum + Number(receipt.amount || 0), 0);
    $(`#${selector}`).textContent = currency.format(totalForMethod);
  });
  $("#checkout-history").innerHTML = data.checkout_history.length ? data.checkout_history.map((receipt) => `
    <tr><td data-label="Receipt"><strong>${escapeHtml(receipt.payment_id || "Legacy")}</strong></td><td data-label="Plate / bay"><strong>${escapeHtml(receipt.plate_number)}</strong><br>${escapeHtml(receipt.slot_id || "-")}</td><td data-label="Duration">${escapeHtml(formatDuration(receipt.duration_minutes ?? (receipt.hours || 0) * 60))}</td><td data-label="Method / reference">${escapeHtml(receipt.payment_method || "Legacy")}<br>${escapeHtml(receipt.payment_reference || "-")}</td><td data-label="Amount" class="amount">${currency.format(Number(receipt.amount))}</td><td data-label="Paid at">${formatDateTime(receipt.paid_at || receipt.checked_out_at)}</td></tr>
  `).join("") : '<tr><td colspan="6" class="empty-table">No completed checkouts yet.</td></tr>';
  if (!state.ratesInitialized) renderRates(data.rate_tiers);
  $("#last-updated").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

async function refreshStatus() {
  try {
    render(await request("/api/status"));
    $("#connection-state").textContent = "Live operations";
    $(".pulse").classList.remove("offline");
  } catch (error) {
    $("#connection-state").textContent = "Offline";
    $(".pulse").classList.add("offline");
  }
}

function setPaymentFields() {
  const needsReference = $("#payment-method").value !== "cash";
  $("#payment-reference-wrap").hidden = !needsReference;
  $("#payment-reference").required = needsReference;
}

async function getQuote(plateNumber) {
  state.quote = await request("/api/exit", { method: "POST", body: JSON.stringify({ plate_number: plateNumber }) });
  $("#checkout-details").hidden = false;
  $("#payment-confirmed").required = true;
  $("#payment-confirmed").checked = false;
  $("#quoted-fee").textContent = currency.format(state.quote.amount);
  $("#quote-summary").textContent = `${formatDuration(state.quote.duration_minutes)} parked · Bay ${state.quote.slot_id}`;
  $("#submit-label").textContent = "Confirm payment & authorize exit";
  setPaymentFields();
}

$("#parking-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const plateNumber = $("#plate-number").value.trim().toUpperCase();
  const submitButton = form.querySelector("button[type='submit']");
  submitButton.disabled = true;
  setFeedback(state.mode === "entry" ? "Recording entry..." : state.quote ? "Recording confirmed payment..." : "Calculating fee...", "");
  try {
    if (state.mode === "entry") {
      const result = await request("/api/entry", { method: "POST", body: JSON.stringify({ plate_number: plateNumber, vehicle_type: $("#vehicle-type").value }) });
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
          plate_number: plateNumber,
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
    submitButton.disabled = false;
  }
});

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
  state.mode = tab.dataset.mode;
  state.quote = null;
  document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
  const entryMode = state.mode === "entry";
  $("#vehicle-type").hidden = !entryMode;
  $("#vehicle-type-label").hidden = !entryMode;
  $("#checkout-details").hidden = true;
  $("#payment-confirmed").required = false;
  $("#payment-reference").required = false;
  $("#submit-label").textContent = entryMode ? "Assign a space" : "Review fee";
  setFeedback();
}));

$("#payment-method").addEventListener("change", setPaymentFields);
$("#rate-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  $("#rate-feedback").textContent = "Saving rates...";
  try {
    const rateTiers = [30, 120, 240, 360, null].map((maxMinutes, index) => ({
      max_minutes: maxMinutes,
      amount: Number(event.currentTarget.elements[`rate-${index}`].value),
    }));
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

$("#today").textContent = new Date().toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
setInterval(() => { $("#clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }, 1000);
refreshStatus();
setInterval(refreshStatus, 5000);


