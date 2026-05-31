function setDailyText(id, text, className = "") {
  const element = document.getElementById(id);
  if (!element) {
    return;
  }
  element.textContent = text;
  element.className = `value ${className}`.trim();
}

function setDailyButtonState(disabled) {
  const button = document.getElementById("dailyUploadBtn");
  if (button) {
    button.disabled = !!disabled;
  }
}

function setHotTagsText(id, text, className = "") {
  const element = document.getElementById(id);
  if (!element) {
    return;
  }
  element.textContent = text;
  element.className = `value ${className}`.trim();
}

function setHotTagsButtonState(disabled) {
  const button = document.getElementById("hotTagsUploadBtn");
  if (button) {
    button.disabled = !!disabled;
  }
}

function formatTimestamp(value) {
  if (!value) {
    return "-";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }
  return parsed.toLocaleString();
}

function buildStatsSummary(stats) {
  const data = stats || {};
  return [
    `Local records: ${Number(data.totalRecords) || 0}`,
    `OK/Stale: ${Number(data.okCount) || 0}/${Number(data.staleCount) || 0}`,
    `Unavailable/Not found: ${Number(data.unavailableCount) || 0}/${Number(data.notFoundCount) || 0}`,
    `Last local update: ${formatTimestamp(data.lastUpdatedAt)}`,
    data.truncated ? "Note: local records were truncated before upload." : null
  ]
    .filter(Boolean)
    .join("\n");
}

function renderDailySummary(summary) {
  if (!summary) {
    setDailyText("dailyUploadStatus", "No local summary", "warn");
    setDailyText("dailyUploadResult", "Open seller analytics first, then retry.");
    return;
  }

  const statusText = summary.lastUpload ? "Ready (last upload found)" : "Ready";
  setDailyText("dailyUploadStatus", statusText, "ok");

  const lines = [buildStatsSummary(summary.stats)];
  if (summary.lastUpload) {
    lines.push(`Last upload: ${formatTimestamp(summary.lastUpload.at || summary.lastUpload.uploadedAt)}`);
    lines.push(`Last uploaded count: ${Number(summary.lastUpload.storedCount) || 0}`);
  }
  setDailyText("dailyUploadResult", lines.join("\n"));
}

async function refreshDailySummary() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "get-daily-analytics-summary"
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Failed to read local summary.");
    }
    renderDailySummary(response.summary || null);
  } catch (error) {
    setDailyText("dailyUploadStatus", "Summary failed", "err");
    setDailyText("dailyUploadResult", error instanceof Error ? error.message : String(error), "err");
  }
}

async function uploadDailyAnalytics() {
  setDailyButtonState(true);
  setDailyText("dailyUploadStatus", "Uploading...", "warn");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "upload-daily-analytics"
    });

    if (!response?.ok) {
      if (response?.code === "cloud_auth_required") {
        setDailyText("dailyUploadStatus", "Cloud login required", "err");
        setDailyText(
          "dailyUploadResult",
          response?.error || "Please log in to your SaaS dashboard and retry.",
          "err"
        );
        return;
      }
      throw new Error(response?.error || "Daily analytics upload failed.");
    }

    const state = response.state || {};
    const resultText = [
      `Uploaded at: ${formatTimestamp(state.uploadedAt || state.at)}`,
      `Local records: ${Number(state.totalRecords) || 0}`,
      `Received: ${Number(state.receivedCount) || 0}`,
      `Stored: ${Number(state.storedCount) || 0}`,
      `Target: ${state.origin || "-"}`
    ].join("\n");
    setDailyText("dailyUploadStatus", "Upload completed", "ok");
    setDailyText("dailyUploadResult", resultText, "ok");
  } catch (error) {
    setDailyText("dailyUploadStatus", "Upload failed", "err");
    setDailyText("dailyUploadResult", error instanceof Error ? error.message : String(error), "err");
  } finally {
    setDailyButtonState(false);
  }
}

document.getElementById("dailyUploadBtn")?.addEventListener("click", () => {
  void uploadDailyAnalytics();
});

async function refreshHotTagsSummary() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "get-hot-tags-upload-summary"
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Failed to read hot tags summary.");
    }
    const lastUpload = response.summary?.lastUpload || null;
    setHotTagsText("hotTagsUploadStatus", lastUpload ? "Ready (last upload found)" : "Ready", "ok");
    setHotTagsText(
      "hotTagsUploadResult",
      lastUpload
        ? [
            `Last upload: ${formatTimestamp(lastUpload.at || lastUpload.uploadedAt)}`,
            `Stored: ${Number(lastUpload.storedCount) || 0}`,
            `Visible dynamics: ${Number(lastUpload.visibleDynamicsAvailableCount) || 0}`
          ].join("\n")
        : "Open seller hot-tags page, then upload."
    );
  } catch (error) {
    setHotTagsText("hotTagsUploadStatus", "Summary failed", "err");
    setHotTagsText("hotTagsUploadResult", error instanceof Error ? error.message : String(error), "err");
  }
}

async function uploadHotTags() {
  setHotTagsButtonState(true);
  setHotTagsText("hotTagsUploadStatus", "Collecting and uploading...", "warn");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "upload-hot-tags"
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Hot tags upload failed.");
    }

    const state = response.state || {};
    setHotTagsText("hotTagsUploadStatus", "Upload completed", "ok");
    setHotTagsText(
      "hotTagsUploadResult",
      [
        `Uploaded at: ${formatTimestamp(state.uploadedAt || state.at)}`,
        `Received: ${Number(state.receivedCount) || 0}`,
        `Stored: ${Number(state.storedCount) || 0}`,
        `Visible dynamics: ${Number(state.visibleDynamicsAvailableCount) || 0}`,
        `Target: ${state.origin || "-"}`
      ].join("\n"),
      "ok"
    );
  } catch (error) {
    setHotTagsText("hotTagsUploadStatus", "Upload failed", "err");
    setHotTagsText("hotTagsUploadResult", error instanceof Error ? error.message : String(error), "err");
  } finally {
    setHotTagsButtonState(false);
  }
}

document.getElementById("hotTagsUploadBtn")?.addEventListener("click", () => {
  void uploadHotTags();
});

void refreshDailySummary();
void refreshHotTagsSummary();
