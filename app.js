const STORAGE_KEY = "spyridon-runs-v1";
const DISTANCES = {
  5000: { label: "5 KM", goalSeconds: 1200 },
  10000: { label: "10 KM", goalSeconds: 2400 },
};
const supabaseClient = window.supabase.createClient(
  window.SPYRIDON_SUPABASE.url,
  window.SPYRIDON_SUPABASE.publishableKey,
);

const elements = Object.fromEntries([
  "chart-state", "latest-time", "latest-date", "personal-best", "personal-best-date",
  "target-gap", "target-label", "target-status", "run-count", "run-ledger", "trend-summary", "form-status",
  "auth-form", "auth-session", "auth-status", "account-email", "sign-out-button", "sign-up-button",
].map((id) => [id, document.querySelector(`#${id}`)]));

let allRuns = [];
let selectedDistance = 5000;
let currentUser = null;
let chart;

function loadStoredRuns() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function fromDatabaseRun(run) {
  return {
    id: run.id,
    date: run.run_date,
    distanceMeters: run.distance_meters,
    timeSeconds: run.time_seconds,
  };
}

function setRunFormEnabled(enabled) {
  document.querySelectorAll("#run-form input, #run-form button").forEach((control) => {
    control.disabled = !enabled;
  });
}

async function loadOnlineRuns() {
  const { data, error } = await supabaseClient
    .from("spyridon_runs")
    .select("id, run_date, distance_meters, time_seconds")
    .order("run_date", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  allRuns = data.map(fromDatabaseRun);
}

async function migrateLocalRuns() {
  const localRuns = loadStoredRuns();
  if (!localRuns.length) return 0;
  const rows = localRuns.map((run) => ({
    id: run.id,
    run_date: run.date,
    distance_meters: run.distanceMeters,
    time_seconds: run.timeSeconds,
  }));
  const { error } = await supabaseClient
    .from("spyridon_runs")
    .upsert(rows, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw error;
  localStorage.removeItem(STORAGE_KEY);
  return rows.length;
}

async function applySession(session) {
  currentUser = session?.user ?? null;
  elements["auth-form"].hidden = Boolean(currentUser);
  elements["auth-session"].hidden = !currentUser;
  elements["account-email"].textContent = currentUser?.email ?? "";
  setRunFormEnabled(Boolean(currentUser));

  if (!currentUser) {
    allRuns = [];
    elements["auth-status"].textContent = "SIGN IN TO SYNC RUNS.";
    render();
    return;
  }

  elements["auth-status"].textContent = "SYNCING...";
  try {
    const imported = await migrateLocalRuns();
    await loadOnlineRuns();
    elements["auth-status"].textContent = imported
      ? `ONLINE / IMPORTED ${imported} LOCAL ${imported === 1 ? "RUN" : "RUNS"}.`
      : "ONLINE / SYNCED.";
  } catch (error) {
    elements["auth-status"].textContent = `SYNC FAILED: ${error.message}`;
  }
  render();
}

function formatTime(totalSeconds) {
  if (!Number.isFinite(totalSeconds)) return "--:--";
  const rounded = Math.round(totalSeconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatPace(timeSeconds, distanceMeters) {
  return formatTime(timeSeconds / (distanceMeters / 1000));
}

function parseTime(value) {
  const parts = value.trim().split(":").map(Number);
  if (parts.some((part) => !Number.isInteger(part)) || parts.length < 2 || parts.length > 3) return null;
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, ...parts];
  if (minutes > 59 || seconds > 59) return null;
  const total = hours * 3600 + minutes * 60 + seconds;
  return total > 0 ? total : null;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    .format(new Date(`${value}T12:00:00`)).toUpperCase();
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function linearRegression(values) {
  if (values.length < 2) return [...values];
  const count = values.length;
  const xSum = values.reduce((sum, _, index) => sum + index, 0);
  const ySum = values.reduce((sum, value) => sum + value, 0);
  const xySum = values.reduce((sum, value, index) => sum + index * value, 0);
  const xxSum = values.reduce((sum, _, index) => sum + index * index, 0);
  const slope = (count * xySum - xSum * ySum) / (count * xxSum - xSum * xSum);
  const intercept = (ySum - slope * xSum) / count;
  return values.map((_, index) => intercept + slope * index);
}

function selectedRuns() {
  return allRuns.filter((run) => run.distanceMeters === selectedDistance)
    .sort((first, second) => first.date.localeCompare(second.date));
}

function updateMetrics(runs, settings) {
  const latest = runs.at(-1);
  const best = runs.reduce((current, run) => !current || run.timeSeconds < current.timeSeconds ? run : current, null);
  const gap = best ? best.timeSeconds - settings.goalSeconds : null;
  elements["latest-time"].textContent = latest ? formatTime(latest.timeSeconds) : "--:--";
  elements["latest-date"].textContent = latest ? formatDate(latest.date) : "NO DATA";
  elements["personal-best"].textContent = best ? formatTime(best.timeSeconds) : "--:--";
  elements["personal-best-date"].textContent = best ? formatDate(best.date) : "NO DATA";
  elements["target-label"].textContent = formatTime(settings.goalSeconds);
  elements["run-count"].textContent = String(runs.length).padStart(2, "0");
  elements["target-gap"].textContent = gap === null ? "--:--" : formatTime(Math.abs(gap));
  elements["target-status"].textContent = gap === null ? "WAITING FOR A RUN" : gap <= 0 ? "GOAL REACHED / MARGIN" : "LEFT TO GO";
}

function updateLedger(runs, settings) {
  const rows = runs.slice(-10).reverse().map((run) => {
    const achieved = run.timeSeconds <= settings.goalSeconds;
    return `<tr><td>${formatDate(run.date)}</td><td><strong>${formatTime(run.timeSeconds)}</strong></td><td>${formatPace(run.timeSeconds, run.distanceMeters)}</td><td><span class="status-mark ${achieved ? "status-mark--goal" : ""}">${achieved ? "GOAL" : "OPEN"}</span></td><td><button class="delete-button" type="button" data-delete-id="${escapeHtml(run.id)}" aria-label="Delete result from ${formatDate(run.date)}">×</button></td></tr>`;
  });
  elements["run-ledger"].innerHTML = rows.length ? rows.join("") : '<tr><td colspan="5">YOUR TIMES WILL APPEAR HERE.</td></tr>';
}

function drawChart(runs, settings) {
  const labels = runs.map((run) => formatDate(run.date));
  const results = runs.map((run) => run.timeSeconds);
  const trend = linearRegression(results);
  const delta = trend.length > 1 ? trend.at(-1) - trend[0] : 0;
  elements["trend-summary"].textContent = runs.length > 1
    ? `TREND: ${delta <= 0 ? "FASTER" : "SLOWER"} BY ${formatTime(Math.abs(delta))}`
    : "TREND: NEEDS 2 RUNS";
  chart?.destroy();
  chart = new Chart(document.querySelector("#progress-chart"), {
    type: "line",
    data: { labels, datasets: [
      { label: "RESULT", data: results, borderColor: "#6d9eb8", backgroundColor: "#f8f7f2", borderWidth: 2, pointRadius: 5, pointHoverRadius: 7, pointBorderWidth: 2, tension: 0, order: 1 },
      { label: "TREND", data: trend, borderColor: "#9d9a91", borderWidth: 1.5, borderDash: [3, 7], pointRadius: 0, tension: 0, order: 2 },
      { label: `GOAL ${settings.label}`, data: labels.map(() => settings.goalSeconds), borderColor: "#c66f6b", borderWidth: 2, borderDash: [10, 7], pointRadius: 0, order: 0 },
    ]},
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#2c2b29",
          titleFont: { family: "Space Mono" },
          bodyFont: { family: "Space Mono" },
          callbacks: { label: (context) => `${context.dataset.label}: ${formatTime(context.raw)}` },
        },
      },
      scales: {
        x: { grid: { color: "rgba(49,48,44,.08)" }, border: { color: "#c8c4ba" }, ticks: { color: "#77746d", font: { family: "Space Mono", size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 7 } },
        y: { grid: { color: "rgba(49,48,44,.1)" }, border: { color: "#c8c4ba" }, ticks: { color: "#77746d", callback: (value) => formatTime(value), font: { family: "Space Mono", size: 9 } } },
      },
    },
  });
}

function render() {
  const settings = DISTANCES[selectedDistance];
  const runs = selectedRuns();
  updateMetrics(runs, settings);
  updateLedger(runs, settings);
  drawChart(runs, settings);
  elements["chart-state"].hidden = runs.length > 0;
  if (!runs.length) elements["chart-state"].textContent = `NO RUNS FOR ${settings.label}`;
}

document.querySelector("#run-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser) {
    elements["form-status"].textContent = "SIGN IN FIRST.";
    return;
  }
  const data = new FormData(event.currentTarget);
  const timeSeconds = parseTime(String(data.get("time")));
  if (!timeSeconds) {
    elements["form-status"].textContent = "USE 24:36 OR 1:02:14.";
    return;
  }
  const distanceMeters = Number(data.get("distance"));
  const submitButton = event.currentTarget.querySelector("[type=submit]");
  submitButton.disabled = true;
  elements["form-status"].textContent = "SAVING...";
  const { data: savedRun, error } = await supabaseClient
    .from("spyridon_runs")
    .insert({ run_date: String(data.get("date")), distance_meters: distanceMeters, time_seconds: timeSeconds })
    .select("id, run_date, distance_meters, time_seconds")
    .single();
  submitButton.disabled = false;
  if (error) {
    elements["form-status"].textContent = `SAVE FAILED: ${error.message}`;
    return;
  }
  allRuns.push(fromDatabaseRun(savedRun));
  selectedDistance = distanceMeters;
  document.querySelectorAll("[data-distance]").forEach((button) => {
    button.classList.toggle("is-active", Number(button.dataset.distance) === selectedDistance);
  });
  event.currentTarget.reset();
  document.querySelector("#run-date").valueAsDate = new Date();
  elements["form-status"].textContent = "SAVED.";
  render();
});

elements["run-ledger"].addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-id]");
  if (!button) return;
  button.disabled = true;
  const { error } = await supabaseClient.from("spyridon_runs").delete().eq("id", button.dataset.deleteId);
  if (error) {
    elements["form-status"].textContent = `DELETE FAILED: ${error.message}`;
    button.disabled = false;
    return;
  }
  allRuns = allRuns.filter((run) => run.id !== button.dataset.deleteId);
  render();
});

document.querySelectorAll("[data-distance]").forEach((button) => button.addEventListener("click", () => {
  selectedDistance = Number(button.dataset.distance);
  document.querySelectorAll("[data-distance]").forEach((item) => item.classList.toggle("is-active", item === button));
  render();
}));

document.querySelector("#run-date").valueAsDate = new Date();
document.querySelector("#footer-year").textContent = String(new Date().getFullYear());
elements["auth-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const email = String(formData.get("email")).trim();
  const password = String(formData.get("password"));
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  elements["auth-status"].textContent = "SIGNING IN...";
  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  button.disabled = false;
  if (error) elements["auth-status"].textContent = `SIGN-IN FAILED: ${error.message}`;
});

elements["sign-up-button"].addEventListener("click", async () => {
  if (!elements["auth-form"].reportValidity()) return;
  const formData = new FormData(elements["auth-form"]);
  const email = String(formData.get("email")).trim();
  const password = String(formData.get("password"));
  elements["sign-up-button"].disabled = true;
  elements["auth-status"].textContent = "CREATING ACCOUNT...";
  const { data, error } = await supabaseClient.auth.signUp({ email, password });
  elements["sign-up-button"].disabled = false;
  elements["auth-status"].textContent = error
    ? `ACCOUNT FAILED: ${error.message}`
    : data.session ? "ACCOUNT CREATED / SIGNED IN." : "ACCOUNT CREATED / CHECK EMAIL ONCE TO CONFIRM.";
});

elements["sign-out-button"].addEventListener("click", async () => {
  elements["auth-status"].textContent = "SIGNING OUT...";
  const { error } = await supabaseClient.auth.signOut();
  if (error) elements["auth-status"].textContent = `SIGN-OUT FAILED: ${error.message}`;
});

setRunFormEnabled(false);
render();

supabaseClient.auth.onAuthStateChange((_event, session) => {
  setTimeout(() => applySession(session), 0);
});

supabaseClient.auth.getSession().then(({ data }) => applySession(data.session));
