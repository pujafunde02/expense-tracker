"use strict";

const STORAGE_KEY = "spendwise-expenses-v1";
const THEME_KEY = "spendwise-theme-v1";
const DATABASE_NAME = "spendwise-database";
const DATABASE_VERSION = 1;
const CATEGORIES = ["Food", "Travel", "Shopping", "Bills", "Other"];
const CATEGORY_COLORS = {
  Food: "#f0a95e",
  Travel: "#62a3e6",
  Shopping: "#d77eaa",
  Bills: "#45b895",
  Other: "#8978e8"
};
const CATEGORY_SYMBOLS = {
  Food: "✳",
  Travel: "➤",
  Shopping: "◇",
  Bills: "▤",
  Other: "✦"
};
const currencyFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2
});

const form = document.getElementById("expenseForm");
const titleInput = document.getElementById("title");
const amountInput = document.getElementById("amount");
const categoryInput = document.getElementById("category");
const dateInput = document.getElementById("date");
const formError = document.getElementById("formError");
const rows = document.getElementById("expenseRows");
const emptyState = document.getElementById("emptyState");
const emptyTitle = document.getElementById("emptyTitle");
const emptyMessage = document.getElementById("emptyMessage");
const searchInput = document.getElementById("searchInput");
const categoryFilter = document.getElementById("categoryFilter");
const toastRegion = document.getElementById("toastRegion");

let expenses = [];
let monthlyBudget = 0;
let editingId = null;
let categoryChart = null;
let reportChart = null;
let databasePromise = null;
let supabaseClient = null;

const SUPABASE_URL = window.SPENDWISE_CONFIG && window.SPENDWISE_CONFIG.supabaseUrl
  ? window.SPENDWISE_CONFIG.supabaseUrl.trim()
  : "";
const SUPABASE_ANON_KEY = window.SPENDWISE_CONFIG && window.SPENDWISE_CONFIG.supabaseAnonKey
  ? window.SPENDWISE_CONFIG.supabaseAnonKey.trim()
  : "";

function isSharedDatabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase && typeof window.supabase.createClient === "function");
}

function getSupabaseClient() {
  if (!isSharedDatabaseConfigured()) return null;
  if (!supabaseClient) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
  }
  return supabaseClient;
}

function updateDataModeNotice() {
  const note = document.getElementById("dataModeNote");
  if (!note) return;
  note.innerHTML = isSharedDatabaseConfigured()
    ? '<span aria-hidden="true">☁</span> Shared data is enabled through the configured database.'
    : '<span aria-hidden="true">⌑</span> Your data is saved privately in this browser.';
}

function localDateString(date = new Date()) {
  const timezoneOffset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - timezoneOffset).toISOString().slice(0, 10);
}

function validateStoredExpenses(parsed) {
  if (!Array.isArray(parsed)) throw new Error("Saved expense data must be a list.");
  return parsed.filter((expense) =>
      expense &&
      typeof expense.id === "string" &&
      typeof expense.title === "string" &&
      Number.isFinite(Number(expense.amount)) &&
      CATEGORIES.includes(expense.category) &&
      typeof expense.date === "string"
    ).map((expense) => ({ ...expense, amount: Number(expense.amount) }));
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("The database transaction was aborted."));
  });
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB is not available in this browser."));
      return;
    }
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("expenses")) {
        database.createObjectStore("expenses", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("settings")) {
        database.createObjectStore("settings", { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("The expense database is blocked by another open tab."));
  });
  databasePromise.catch(() => { databasePromise = null; });
  return databasePromise;
}

function readLegacyExpenses() {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored ? validateStoredExpenses(JSON.parse(stored)) : [];
}

async function loadDatabaseData() {
  const client = getSupabaseClient();
  if (client) {
    const [{ data: expenseRows, error: expenseError }, { data: settingRows, error: settingsError }] = await Promise.all([
      client.from("expenses").select("*").order("date", { ascending: false }),
      client.from("settings").select("*")
    ]);

    if (expenseError || settingsError) {
      console.error("Could not read shared database:", expenseError || settingsError);
      throw new Error("The shared database could not be reached.");
    }

    const sharedBudget = Array.isArray(settingRows)
      ? settingRows.find((row) => row.key === "monthlyBudget")
      : null;
    expenses = validateStoredExpenses((expenseRows || []).map((row) => ({
      id: row.id,
      title: row.title,
      amount: Number(row.amount),
      category: row.category,
      date: row.date
    })));
    monthlyBudget = sharedBudget && Number.isFinite(Number(sharedBudget.value)) && Number(sharedBudget.value) > 0
      ? Number(sharedBudget.value)
      : 0;
    return;
  }

  const database = await openDatabase();
  const transaction = database.transaction(["expenses", "settings"], "readonly");
  const done = transactionComplete(transaction);
  const [storedExpenses, savedBudget, migrationRecord] = await Promise.all([
    requestValue(transaction.objectStore("expenses").getAll()),
    requestValue(transaction.objectStore("settings").get("monthlyBudget")),
    requestValue(transaction.objectStore("settings").get("legacyMigrationComplete"))
  ]);
  await done;
  expenses = validateStoredExpenses(storedExpenses);
  monthlyBudget = savedBudget && Number.isFinite(Number(savedBudget.value)) && Number(savedBudget.value) > 0
    ? Number(savedBudget.value)
    : 0;

  if (!migrationRecord || migrationRecord.value !== true) {
    try {
      if (storedExpenses.length === 0) {
        expenses = readLegacyExpenses();
      }
      if (expenses.length > 0 && storedExpenses.length === 0) {
        await saveExpenses();
      }
      await saveSetting("legacyMigrationComplete", true);
    } catch (error) {
      console.error("Could not migrate saved expenses:", error);
      notify("Older saved expenses couldn't be migrated from browser storage.", "error");
    }
  }
}

async function saveExpenses() {
  const client = getSupabaseClient();
  if (client) {
    const payload = expenses.map((expense) => ({
      id: expense.id,
      title: expense.title,
      amount: Number(expense.amount),
      category: expense.category,
      date: expense.date
    }));
    const { error: upsertError } = await client.from("expenses").upsert(payload, { onConflict: "id" });
    if (upsertError) {
      throw upsertError;
    }
    const { data: remoteRows, error: fetchError } = await client.from("expenses").select("id");
    if (fetchError) throw fetchError;
    const remoteIds = (remoteRows || []).map((row) => row.id);
    const staleIds = remoteIds.filter((id) => !expenses.some((expense) => expense.id === id));
    if (staleIds.length > 0) {
      const { error: deleteError } = await client.from("expenses").delete().in("id", staleIds);
      if (deleteError) throw deleteError;
    }
    return;
  }

  const database = await openDatabase();
  const transaction = database.transaction("expenses", "readwrite");
  const done = transactionComplete(transaction);
  const store = transaction.objectStore("expenses");
  store.clear();
  expenses.forEach((expense) => store.put(expense));
  await done;
}

async function saveSetting(key, value) {
  const client = getSupabaseClient();
  if (client) {
    const { error } = await client.from("settings").upsert({ key, value }, { onConflict: "key" });
    if (error) throw error;
    return;
  }

  const database = await openDatabase();
  const transaction = database.transaction("settings", "readwrite");
  const done = transactionComplete(transaction);
  transaction.objectStore("settings").put({ key, value });
  await done;
}

async function saveMonthlyBudget(value) {
  await saveSetting("monthlyBudget", value);
}

function formatCurrency(amount) {
  return currencyFormatter.format(amount);
}

function formatDate(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateString;
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(date);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character]);
}

function notify(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 3600);
}

function getFilteredExpenses() {
  const query = searchInput.value.trim().toLocaleLowerCase();
  const category = categoryFilter.value;
  return [...expenses]
    .filter((expense) => expense.title.toLocaleLowerCase().includes(query))
    .filter((expense) => category === "all" || expense.category === category)
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

function renderSummary() {
  const total = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const now = new Date();
  const monthTotal = expenses
    .filter((expense) => {
      const date = new Date(`${expense.date}T00:00:00`);
      return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
    })
    .reduce((sum, expense) => sum + expense.amount, 0);
  document.getElementById("totalExpenses").textContent = formatCurrency(total);
  document.getElementById("transactionCount").textContent = expenses.length.toLocaleString("en-IN");
  document.getElementById("monthlyExpenses").textContent = formatCurrency(monthTotal);
  document.getElementById("monthCaption").textContent = new Intl.DateTimeFormat("en-IN", {
    month: "long",
    year: "numeric"
  }).format(now);
}

function renderRows() {
  const visibleExpenses = getFilteredExpenses();
  document.getElementById("listCount").textContent = visibleExpenses.length;
  rows.innerHTML = visibleExpenses.map((expense) => {
    const categoryClass = expense.category.toLowerCase();
    return `
      <tr>
        <td>
          <div class="expense-title-cell">
            <span class="expense-symbol ${categoryClass}" aria-hidden="true">${CATEGORY_SYMBOLS[expense.category]}</span>
            <span>${escapeHtml(expense.title)}</span>
          </div>
        </td>
        <td class="amount-cell">${formatCurrency(expense.amount)}</td>
        <td><span class="category-tag ${categoryClass}">${expense.category}</span></td>
        <td>${formatDate(expense.date)}</td>
        <td class="action-cell">
          <span class="row-actions">
            <button class="row-action" type="button" data-action="edit" data-id="${escapeHtml(expense.id)}" aria-label="Edit ${escapeHtml(expense.title)}" title="Edit">✎</button>
            <button class="row-action delete" type="button" data-action="delete" data-id="${escapeHtml(expense.id)}" aria-label="Delete ${escapeHtml(expense.title)}" title="Delete">⌫</button>
          </span>
        </td>
      </tr>`;
  }).join("");

  const noExpenses = expenses.length === 0;
  const noMatches = !noExpenses && visibleExpenses.length === 0;
  emptyState.classList.toggle("hidden", visibleExpenses.length > 0);
  emptyTitle.textContent = noMatches ? "No matching expenses" : "No expenses yet";
  emptyMessage.textContent = noMatches
    ? "Try a different search or category filter."
    : "Add your first expense to see it here.";
  document.getElementById("emptyAdd").classList.toggle("hidden", noMatches);
  document.querySelector("thead").classList.toggle("hidden", visibleExpenses.length === 0);
}

function renderChart() {
  const totals = CATEGORIES.map((category) => expenses
    .filter((expense) => expense.category === category)
    .reduce((sum, expense) => sum + expense.amount, 0));
  const hasExpenses = totals.some((amount) => amount > 0);
  const canvas = document.getElementById("categoryChart");
  document.getElementById("chartEmpty").classList.toggle("hidden", hasExpenses);
  canvas.classList.toggle("hidden", !hasExpenses);

  document.getElementById("chartLegend").innerHTML = hasExpenses
    ? CATEGORIES.map((category, index) => totals[index] > 0
      ? `<span class="legend-item"><span class="legend-dot" style="background:${CATEGORY_COLORS[category]}"></span>${category}</span>`
      : "").join("")
    : "";

  if (!hasExpenses || typeof Chart === "undefined") {
    if (categoryChart) {
      categoryChart.destroy();
      categoryChart = null;
    }
    if (hasExpenses) notify("The chart library couldn't load. Check your internet connection.", "error");
    return;
  }

  const data = {
    labels: CATEGORIES,
    datasets: [{
      data: totals,
      backgroundColor: CATEGORIES.map((category) => CATEGORY_COLORS[category]),
      borderColor: getComputedStyle(document.body).getPropertyValue("--surface-solid").trim() || "#fff",
      borderWidth: 4,
      hoverOffset: 7
    }]
  };
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label(context) { return ` ${context.label}: ${formatCurrency(context.raw)}`; }
        }
      }
    },
    animation: { duration: 450 }
  };

  if (categoryChart) {
    categoryChart.data = data;
    categoryChart.options = options;
    categoryChart.update();
  } else {
    categoryChart = new Chart(canvas, { type: "pie", data, options });
  }
}

function getMonthExpenses(date = new Date()) {
  return expenses.filter((expense) => {
    const expenseDate = new Date(`${expense.date}T00:00:00`);
    return expenseDate.getMonth() === date.getMonth() && expenseDate.getFullYear() === date.getFullYear();
  });
}

function renderBudget() {
  const monthExpenses = getMonthExpenses();
  const spent = monthExpenses.reduce((sum, expense) => sum + expense.amount, 0);
  const progress = document.getElementById("budgetProgress");
  const fill = document.getElementById("budgetProgressFill");
  const remaining = document.getElementById("budgetRemaining");
  const caption = document.getElementById("budgetCaption");
  const budgetInput = document.getElementById("budgetAmount");
  document.getElementById("budgetMonthLabel").textContent = `Your limit for ${new Intl.DateTimeFormat("en-IN", {
    month: "long",
    year: "numeric"
  }).format(new Date())}.`;
  budgetInput.value = monthlyBudget || "";
  document.getElementById("budgetSpent").textContent = `${formatCurrency(spent)} spent`;

  if (!monthlyBudget) {
    fill.style.width = "0%";
    progress.setAttribute("aria-valuenow", "0");
    progress.classList.remove("over-budget");
    remaining.textContent = "No budget set";
    caption.textContent = "Set a monthly limit to start tracking your progress.";
    return;
  }

  const percentage = spent / monthlyBudget * 100;
  const exceeded = percentage > 100;
  const remainingAmount = monthlyBudget - spent;
  fill.style.width = `${Math.min(100, percentage)}%`;
  progress.setAttribute("aria-valuenow", String(Math.min(100, Math.round(percentage))));
  progress.classList.toggle("over-budget", exceeded);
  remaining.textContent = remainingAmount >= 0
    ? `${formatCurrency(remainingAmount)} left`
    : `${formatCurrency(Math.abs(remainingAmount))} over`;
  caption.textContent = `${Math.round(percentage)}% of your monthly budget used${exceeded ? " — you've passed your limit." : "."}`;
}

function renderReport() {
  const period = document.getElementById("reportPeriod").value;
  const today = new Date();
  let dates;
  let labels;
  let rangeLabel;

  if (period === "weekly") {
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    dates = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return date;
    });
    labels = dates.map((date) => new Intl.DateTimeFormat("en-IN", { weekday: "short" }).format(date));
    rangeLabel = `${formatDate(localDateString(dates[0]))} – ${formatDate(localDateString(dates[6]))}`;
    document.getElementById("reportTitle").textContent = "Weekly report";
  } else {
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    dates = Array.from({ length: daysInMonth }, (_, index) => new Date(today.getFullYear(), today.getMonth(), index + 1));
    labels = dates.map((date) => date.getDate() % 5 === 1 || date.getDate() === daysInMonth ? String(date.getDate()) : "");
    rangeLabel = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(today);
    document.getElementById("reportTitle").textContent = "Monthly report";
  }

  const totals = dates.map((date) => {
    const key = localDateString(date);
    return expenses
      .filter((expense) => expense.date === key)
      .reduce((sum, expense) => sum + expense.amount, 0);
  });
  const startKey = localDateString(dates[0]);
  const endKey = localDateString(dates[dates.length - 1]);
  const periodExpenses = expenses.filter((expense) => expense.date >= startKey && expense.date <= endKey);
  const total = periodExpenses.reduce((sum, expense) => sum + expense.amount, 0);
  const hasExpenses = periodExpenses.length > 0;
  const canvas = document.getElementById("reportChart");
  document.getElementById("reportRange").textContent = rangeLabel;
  document.getElementById("reportEmpty").classList.toggle("hidden", hasExpenses);
  canvas.classList.toggle("hidden", !hasExpenses);
  document.getElementById("reportTransactionCount").textContent =
    `${periodExpenses.length.toLocaleString("en-IN")} ${periodExpenses.length === 1 ? "transaction" : "transactions"}`;
  document.getElementById("reportTotal").textContent = formatCurrency(total);

  if (!hasExpenses || typeof Chart === "undefined") {
    if (reportChart) {
      reportChart.destroy();
      reportChart = null;
    }
    if (hasExpenses) notify("The chart library couldn't load. Check your internet connection.", "error");
    return;
  }

  const data = {
    labels,
    datasets: [{
      label: "Expenses",
      data: totals,
      backgroundColor: "rgba(119, 101, 232, 0.72)",
      hoverBackgroundColor: "#6551d4",
      borderRadius: 5,
      maxBarThickness: 22
    }]
  };
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title(items) { return formatDate(localDateString(dates[items[0].dataIndex])); },
          label(context) { return ` ${formatCurrency(context.raw)}`; }
        }
      }
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: getComputedStyle(document.body).getPropertyValue("--muted"), maxRotation: 0 } },
      y: {
        beginAtZero: true,
        grid: { color: getComputedStyle(document.body).getPropertyValue("--border") },
        ticks: { color: getComputedStyle(document.body).getPropertyValue("--muted"), callback(value) { return `₹${value}`; } }
      }
    }
  };

  if (reportChart) {
    reportChart.data = data;
    reportChart.options = options;
    reportChart.update();
  } else {
    reportChart = new Chart(canvas, { type: "bar", data, options });
  }
}

function render() {
  renderSummary();
  renderRows();
  renderChart();
  renderBudget();
  renderReport();
}

function resetForm() {
  form.reset();
  dateInput.value = localDateString();
  editingId = null;
  formError.textContent = "";
  document.getElementById("formHeading").textContent = "Add an expense";
  document.getElementById("submitButton").innerHTML = 'Add Expense <span aria-hidden="true">↗</span>';
  document.getElementById("cancelEdit").classList.add("hidden");
}

function validateExpense({ title, amount, category, date }) {
  if (!title || !amount || !category || !date) return "Please fill in every field.";
  if (title.length > 70) return "Keep the title under 70 characters.";
  if (!Number.isFinite(amount) || amount <= 0) return "Enter an amount greater than zero.";
  if (!CATEGORIES.includes(category)) return "Choose a valid expense category.";
  if (Number.isNaN(new Date(`${date}T00:00:00`).getTime())) return "Choose a valid expense date.";
  return "";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const expense = {
    title: titleInput.value.trim(),
    amount: Number(amountInput.value),
    category: categoryInput.value,
    date: dateInput.value
  };
  const error = validateExpense(expense);
  if (error) {
    formError.textContent = error;
    notify(error, "error");
    return;
  }

  if (editingId) {
    const previousExpenses = expenses;
    expenses = expenses.map((item) => item.id === editingId ? { ...expense, id: editingId } : item);
    try {
      await saveExpenses();
    } catch (error) {
      console.error("Could not update saved expense:", error);
      expenses = previousExpenses;
      notify("Your change couldn't be saved to the browser database.", "error");
      return;
    }
    notify("Expense updated successfully.");
  } else {
    const addedExpense = {
      ...expense,
      id: window.crypto && typeof window.crypto.randomUUID === "function"
        ? window.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`
    };
    expenses.push(addedExpense);
    try {
      await saveExpenses();
    } catch (error) {
      console.error("Could not save new expense:", error);
      expenses = expenses.filter((item) => item.id !== addedExpense.id);
      notify("Your expense couldn't be saved to the browser database.", "error");
      return;
    }
    notify("Expense added successfully.");
  }

  resetForm();
  render();
});

rows.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  const expense = expenses.find((item) => item.id === id);
  if (!expense) return;

  if (action === "edit") {
    editingId = expense.id;
    titleInput.value = expense.title;
    amountInput.value = expense.amount;
    categoryInput.value = expense.category;
    dateInput.value = expense.date;
    formError.textContent = "";
    document.getElementById("formHeading").textContent = "Edit expense";
    document.getElementById("submitButton").innerHTML = 'Save changes <span aria-hidden="true">↗</span>';
    document.getElementById("cancelEdit").classList.remove("hidden");
    document.getElementById("formPanel").scrollIntoView({ behavior: "smooth", block: "center" });
    titleInput.focus({ preventScroll: true });
    return;
  }

  if (action === "delete" && window.confirm(`Delete "${expense.title}"?`)) {
    const previousExpenses = expenses;
    expenses = expenses.filter((item) => item.id !== id);
    try {
      await saveExpenses();
    } catch (error) {
      console.error("Could not delete saved expense:", error);
      expenses = previousExpenses;
      notify("The expense couldn't be deleted from the browser database.", "error");
      return;
    }
    if (editingId === id) resetForm();
    render();
    notify("Expense deleted.");
  }
});

document.getElementById("cancelEdit").addEventListener("click", resetForm);
document.getElementById("reportPeriod").addEventListener("change", renderReport);
document.getElementById("budgetForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("budgetAmount");
  const value = Number(input.value);
  if (!Number.isFinite(value) || value <= 0) {
    notify("Enter a monthly budget greater than zero.", "error");
    input.focus();
    return;
  }

  const previousBudget = monthlyBudget;
  monthlyBudget = value;
  try {
    await saveMonthlyBudget(monthlyBudget);
    renderBudget();
    notify("Monthly budget saved.");
  } catch (error) {
    console.error("Could not save monthly budget:", error);
    monthlyBudget = previousBudget;
    renderBudget();
    notify("Your budget couldn't be saved to the browser database.", "error");
  }
});
searchInput.addEventListener("input", renderRows);
categoryFilter.addEventListener("change", renderRows);
document.getElementById("jumpToForm").addEventListener("click", () => {
  document.getElementById("formPanel").scrollIntoView({ behavior: "smooth", block: "center" });
  titleInput.focus({ preventScroll: true });
});
document.getElementById("emptyAdd").addEventListener("click", () => {
  document.getElementById("formPanel").scrollIntoView({ behavior: "smooth", block: "center" });
  titleInput.focus({ preventScroll: true });
});

function csvCell(value) {
  let safeValue = String(value);
  if (/^[\s]*[=+\-@]/.test(safeValue)) safeValue = `'${safeValue}`;
  return `"${safeValue.replace(/"/g, '""')}"`;
}

document.getElementById("exportCsv").addEventListener("click", () => {
  if (expenses.length === 0) {
    notify("Add an expense before exporting a report.", "error");
    return;
  }
  const header = ["Title", "Amount (INR)", "Category", "Date"];
  const records = [...expenses]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((expense) => [expense.title, expense.amount.toFixed(2), expense.category, expense.date]);
  const csv = [header, ...records].map((record) => record.map(csvCell).join(",")).join("\r\n");
  downloadFile(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }), "spendwise-expenses.csv");
  notify("CSV report downloaded.");
});

document.getElementById("exportPdf").addEventListener("click", () => {
  if (expenses.length === 0) {
    notify("Add an expense before exporting a report.", "error");
    return;
  }
  if (!window.jspdf || typeof window.jspdf.jsPDF !== "function") {
    notify("The PDF library couldn't load. Check your internet connection.", "error");
    return;
  }

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const sortedExpenses = [...expenses].sort((a, b) => b.date.localeCompare(a.date));
  const total = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  let y = 22;

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(20);
  pdf.setTextColor(102, 81, 212);
  pdf.text("Spendwise Expense Report", 14, y);
  y += 9;
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(10);
  pdf.setTextColor(100, 100, 120);
  pdf.text(`Generated ${new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date())}`, 14, y);
  y += 7;
  pdf.text(`Total: INR ${total.toFixed(2)}   |   Transactions: ${expenses.length}`, 14, y);
  y += 12;

  pdf.setFont("helvetica", "bold");
  pdf.setFillColor(241, 239, 255);
  pdf.rect(14, y - 5, 182, 9, "F");
  pdf.text("Title", 16, y);
  pdf.text("Amount", 112, y);
  pdf.text("Category", 146, y);
  pdf.text("Date", 174, y);
  y += 10;
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);

  sortedExpenses.forEach((expense) => {
    if (y > pageHeight - 15) {
      pdf.addPage();
      y = 20;
    }
    const titleLines = pdf.splitTextToSize(expense.title, 88);
    pdf.text(titleLines, 16, y);
    pdf.text(`INR ${expense.amount.toFixed(2)}`, 112, y);
    pdf.text(expense.category, 146, y);
    pdf.text(expense.date, 174, y);
    y += Math.max(8, titleLines.length * 5 + 2);
    pdf.setDrawColor(230, 229, 238);
    pdf.line(14, y - 4, 196, y - 4);
  });

  pdf.save("spendwise-expense-report.pdf");
  notify("PDF report downloaded.");
});

function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setTheme(theme) {
  const isDark = theme === "dark";
  document.body.classList.toggle("dark", isDark);
  document.getElementById("themeIcon").textContent = isDark ? "☀" : "☾";
  document.getElementById("themeToggle").setAttribute("aria-label", `Switch to ${isDark ? "light" : "dark"} mode`);
  try {
    localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
  } catch (error) {
    console.error("Could not save theme preference:", error);
  }
  if (categoryChart) renderChart();
}

document.getElementById("themeToggle").addEventListener("click", () => {
  setTheme(document.body.classList.contains("dark") ? "light" : "dark");
});

async function initialize() {
  dateInput.value = localDateString();
  document.getElementById("todayLabel").textContent = new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric"
  }).format(new Date());
  document.getElementById("footerYear").textContent = new Date().getFullYear();
  try {
    if (localStorage.getItem(THEME_KEY) === "dark") {
      document.body.classList.add("dark");
      document.getElementById("themeIcon").textContent = "☀";
      document.getElementById("themeToggle").setAttribute("aria-label", "Switch to light mode");
    }
  } catch (error) {
    console.error("Could not read theme preference:", error);
  }
  try {
    await loadDatabaseData();
  } catch (error) {
    console.error("Could not open the expense database:", error);
    notify("The browser database couldn't be opened. Your changes may not be saved.", "error");
  }
  render();
}

initialize();
