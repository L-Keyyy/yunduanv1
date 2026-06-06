async function getActiveTab() {
  const tabs = await chrome.tabs.query({ currentWindow: true });

  const preferred =
    tabs.find((tab) => tab.active && !String(tab.url || "").startsWith("chrome-extension://")) ||
    tabs.find((tab) => /:\/\/(?:www\.)?ozon\.ru\/product\//i.test(tab.url || "")) ||
    tabs.find((tab) => !String(tab.url || "").startsWith("chrome-extension://")) ||
    tabs[0];

  return preferred || null;
}

async function getJob(tabId) {
  const response = await chrome.runtime.sendMessage({ type: "get-job", tabId });
  return response?.job || null;
}

function setText(id, text, className = "") {
  const element = document.getElementById(id);
  element.textContent = text;
  element.className = `value ${className}`.trim();
}

function setButtonState(id, disabled) {
  const element = document.getElementById(id);
  if (element) {
    element.disabled = disabled;
  }
}

function buildWeightSummary(result) {
  return [
    `Weight: ${result.weightText || "-"}`,
    `Method: ${result.method || "-"}`,
    `Product ID: ${result.productId || "-"}`,
    `Order Info: ${result.orderInfo || "-"}`,
    result.warning ? `Warning: ${result.warning}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

function buildExtractAllSummary(result) {
  return [
    `Title: ${result.title || "-"}`,
    `Product ID: ${result.productId || "-"}`,
    `Product Weight: ${result.productWeight?.weightText || "-"}`,
    `Package Weight: ${result.packageWeight?.weightText || "-"}`,
    `Weight Method: ${result.packageWeight?.method || "-"}`,
    `Marketing Labels: ${(result.marketingLabels || []).length}`,
    `Hashtags: ${(result.hashtags || []).length}`,
    `Characteristics: ${(result.characteristics || []).length}`,
    `Gallery Images: ${(result.gallery?.images || []).length}`,
    `Gallery Videos: ${(result.gallery?.videos || []).length}`
  ].join("\n");
}

function getSummary(job) {
  if (job.jobType === "extract-all") {
    return buildExtractAllSummary(job.result);
  }
  return buildWeightSummary(job.result);
}

function renderJob(job) {
  if (!job) {
    setText("status", "Idle");
    setText("result", "No result yet.");
    return;
  }

  if (job.status === "running") {
    setText("status", `Running: ${job.jobType || "job"} / ${job.stage}`, "warn");
    setText("result", "Waiting for result...");
    return;
  }

  if (job.status === "error") {
    setText("status", "Failed", "err");
    setText("result", job.error || "Unknown error.", "err");
    return;
  }

  if (job.status === "done" && job.result) {
    setText("status", "Done", "ok");
    setText("result", getSummary(job), job.result.warning ? "warn" : "ok");
    return;
  }

  setText("status", job.status || "Unknown");
  setText("result", "No result yet.");
}

async function refresh() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    setText("status", "No active tab", "err");
    setText("result", "No result yet.");
    return;
  }

  const job = await getJob(tab.id);
  renderJob(job);
}

async function startJob(jobType) {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url) {
    setText("status", "No active tab", "err");
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "start-job",
    tabId: tab.id,
    url: tab.url,
    jobType
  });

  if (!response?.ok) {
    setText("status", "Start failed", "err");
    setText("result", response?.error || "Unknown error.", "err");
    return;
  }

  await refresh();
}

document.getElementById("extractAllBtn").addEventListener("click", async () => {
  await startJob("extract-all");
});

document.getElementById("weightBtn").addEventListener("click", async () => {
  await startJob("weight");
});

document.getElementById("clearBtn").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) {
    return;
  }

  await chrome.runtime.sendMessage({ type: "clear-job", tabId: tab.id });
  await refresh();
});

void refresh();
setInterval(() => {
  void refresh();
}, 1000);
