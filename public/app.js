/**
 * Agent Viewer app logic (state, SSE, UI).
 *
 * Depends on: renderers.js (renderEvent, renderCodexEvent, etc.)
 */

// --- State ---

const state = {
  files: [],
  fileContents: {},
  fileLoadState: {},
  selectedFile: null,
  loadingFileId: null,
  userScrolledUp: false,
  eventSource: null,
  loadToken: 0,
  scrollLazyLoadArmed: false,
  searchQuery: "",
  searchMatches: [],
  searchIndex: -1,
};

const INITIAL_CHUNK_SIZE = 64 * 1024;
const SCROLL_LOAD_THRESHOLD = 600;

// --- DOM refs ---

const els = {
  fileList: document.getElementById("fileList"),
  fileCount: document.getElementById("fileCount"),
  contentHeader: document.getElementById("contentHeader"),
  contentTitle: document.getElementById("contentTitle"),
  copyPathBtn: document.getElementById("copyPathBtn"),
  contentMeta: document.getElementById("contentMeta"),
  outputContainer: document.getElementById("outputContainer"),
  outputContent: document.getElementById("outputContent"),
  emptyState: document.getElementById("emptyState"),
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  tasksDir: document.getElementById("tasksDir"),
  toast: document.getElementById("toast"),
  searchInput: document.getElementById("searchInput"),
  searchCount: document.getElementById("searchCount"),
};

// --- Helpers ---

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatRelativeDate(ms) {
  const now = new Date();
  const date = new Date(ms);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const fileStart = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  const diffDays = Math.round((todayStart - fileStart) / 86400000);
  if (diffDays === 0) return null;
  if (diffDays === 1) return "yesterday";
  return `${diffDays} days ago`;
}

function showToast(message, type = "info") {
  els.toast.textContent = message;
  els.toast.className = `toast ${type} show`;
  setTimeout(() => els.toast.classList.remove("show"), 2000);
}

function getFilePromptTitle(file, fallback) {
  return normalizePromptTitle(file?.promptPreview || file?.title || fallback);
}

function getFilePath(file) {
  if (!file) return "";
  if (file.filePath) return file.filePath;
  if (file.source === "codex" && file.filename) return file.filename;
  if (file.filename) return `${file.id}.output`;
  return file.id || "";
}

function formatShortPath(filePath) {
  if (!filePath) return "";
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length === 0) return filePath;
  const first = filePath.startsWith("/") ? `/${parts[0]}` : parts[0];
  return `${first}...${formatCompactFileName(parts[parts.length - 1])}`;
}

function formatCompactFileName(fileName) {
  const dotIndex = fileName.lastIndexOf(".");
  const extension = dotIndex > 0 ? fileName.slice(dotIndex) : "";
  const baseName = extension
    ? fileName.slice(0, -extension.length)
    : fileName;
  if (baseName.length <= 7) return fileName;
  return `${baseName.slice(-7)}${extension}`;
}

function normalizePromptTitle(title) {
  return String(title || "")
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, " [image] ")
    .replace(/<image\s*\/>/gi, " [image] ")
    .replace(/\s+/g, " ")
    .trim();
}

function setConnectionStatus(status) {
  els.statusDot.className = `status-dot ${status}`;
  els.statusText.textContent =
    status === "connected"
      ? "Connected"
      : status === "reconnecting"
        ? "Reconnecting..."
        : "Disconnected";
}

// --- Collapsible toggle (used by renderers via onclick) ---

function toggleBlock(id) {
  const body = document.getElementById(id);
  const chevron = document.getElementById("chev-" + id);
  if (!body) return;
  body.classList.toggle("open");
  if (chevron) chevron.classList.toggle("open");
}

// --- JSONL Parser ---

function parseJSONL(content) {
  if (!content) return [];
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function parseJSONLChunk(content, loadState, isDone) {
  const combined = `${loadState?.pendingLine || ""}${content || ""}`;
  if (!combined) return { events: [], plainText: "" };

  const lines = combined.split("\n");
  let pendingLine = "";
  if (!combined.endsWith("\n")) {
    pendingLine = lines.pop() || "";
  }
  if (isDone && pendingLine) {
    lines.push(pendingLine);
    pendingLine = "";
  }
  if (loadState) loadState.pendingLine = pendingLine;

  const events = [];
  const plainLines = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      plainLines.push(line);
    }
  }

  return { events, plainText: plainLines.join("\n") };
}

// --- Codex format detection ---

function isCodexFormat(events) {
  if (events.length === 0) return false;
  const first = events[0];
  return first.type === "session_meta" || first.payload !== undefined;
}

// --- Rendering ---

function renderFileList() {
  els.fileCount.textContent = state.files.length;
  els.fileList.innerHTML = state.files
    .map((f) => {
      const isCodex = f.source === "codex";
      const isClaudeProject = f.source === "claude-project";
      const sourceBadge = isCodex
        ? '<span class="source-badge source-codex">Cx</span>'
        : isClaudeProject
          ? '<span class="source-badge source-claude-project">Cp</span>'
          : '<span class="source-badge source-claude">Cl</span>';
      const displayId = isCodex
        ? f.id.replace("codex-", "").slice(0, 12)
        : f.displayLabel || f.filename || f.id;
      const displayTitle = getFilePromptTitle(f, displayId);
      const imagePreviews = Array.isArray(f.imagePreviews) ? f.imagePreviews : [];
      const previewImages = imagePreviews.length
        ? `<div class="file-images">${imagePreviews
            .slice(0, 2)
            .map(
              (image) =>
                `<img class="file-image-preview" src="${escapeHtml(image.endpoint)}" alt="Prompt image ${image.index + 1}" loading="lazy">`,
            )
            .join("")}${imagePreviews.length > 2 ? `<span class="file-image-more">+${imagePreviews.length - 2}</span>` : ""}</div>`
        : "";
      return `<div class="file-item ${f.id === state.selectedFile ? "active" : ""} ${f.hasUpdate ? "has-update" : ""}"
           onclick="selectFile('${f.id}')">
        <div class="file-id" title="${escapeHtml(displayTitle)}">${sourceBadge}<span class="file-title">${escapeHtml(displayTitle)}</span></div>
        ${previewImages}
        <div class="file-meta"><span class="file-ref">${escapeHtml(displayId)}</span><span>${[formatRelativeDate(f.modified), formatTime(f.modified)].filter(Boolean).join(" ")}</span></div>
        <div class="file-meta"><span>${formatSize(f.size)}</span></div>
      </div>`;
    })
    .join("");
}

function renderContent() {
  if (!state.selectedFile) {
    els.contentHeader.style.display = "none";
    els.emptyState.style.display = "flex";
    els.outputContent.innerHTML = "";
    return;
  }
  els.contentHeader.style.display = "flex";
  els.emptyState.style.display = "none";

  const file = state.files.find((f) => f.id === state.selectedFile);
  if (file) {
    const filePath = getFilePath(file);
    const loadState = state.fileLoadState[state.selectedFile];
    const loadedLabel = loadState?.offset
      ? ` | ${loadState.done ? "fully loaded" : `${formatSize(loadState.offset)} loaded`}`
      : "";
    els.contentTitle.textContent = formatShortPath(filePath);
    els.contentTitle.title = filePath;
    els.copyPathBtn.dataset.path = filePath;
    els.contentMeta.textContent = `${formatSize(file.size)} | ${formatTime(file.modified)}${loadedLabel}`;
  }

  if (state.loadingFileId === state.selectedFile) {
    els.outputContent.innerHTML =
      '<div class="empty-state"><div style="font-size: 12px">Loading output...</div></div>';
    return;
  }

  const content = state.fileContents[state.selectedFile] || "";
  const events = parseJSONL(content);
  resetBlockCounter();
  resetCodexState();

  if (events.length > 0) {
    const isCodex = file?.source === "codex" || isCodexFormat(events);
    const renderer = isCodex
      ? (event) => renderCodexEvent(event, file)
      : renderEvent;
    els.outputContent.innerHTML = events.map(renderer).join("");
  } else if (content.trim()) {
    // Not JSONL — render as plain text (with diff detection)
    if (isDiff(content)) {
      els.outputContent.innerHTML = `<div class="md-content"><pre><code>${highlightDiff(content)}</code></pre></div>`;
    } else {
      els.outputContent.innerHTML = `<div class="md-content"><pre><code>${escapeHtml(content)}</code></pre></div>`;
    }
  } else {
    els.outputContent.innerHTML = "";
  }

  updateLoadMoreControl(state.selectedFile);

  const selectedLoadState = state.fileLoadState[state.selectedFile];
  if (!selectedLoadState && !state.userScrolledUp) {
    requestAnimationFrame(() => {
      els.outputContainer.scrollTop = els.outputContainer.scrollHeight;
    });
  }
}

function removeLoadMoreControl() {
  document.getElementById("logLoadMore")?.remove();
}

function updateLoadMoreControl(id) {
  removeLoadMoreControl();
  if (!id || id !== state.selectedFile) return;
  const loadState = state.fileLoadState[id];
  if (!loadState || loadState.done) return;

  const control = document.createElement("div");
  control.id = "logLoadMore";
  control.className = "load-more";
  if (loadState.loading) {
    control.innerHTML = '<span class="load-more-status">Loading...</span>';
  } else {
    control.innerHTML = '<button class="btn load-more-btn" onclick="loadMoreSelected()">Load more</button>';
  }
  els.outputContent.appendChild(control);
}

function renderChunk(content, file, isFirstChunk, loadState, isDone) {
  removeLoadMoreControl();
  const { events, plainText } = parseJSONLChunk(content, loadState, isDone);
  if (events.length > 0) {
    const isCodex = file?.source === "codex" || isCodexFormat(events);
    if (isFirstChunk) {
      resetBlockCounter();
      resetCodexState();
    }
    const renderer = isCodex
      ? (event) => renderCodexEvent(event, file)
      : renderEvent;
    const html = events.map(renderer).join("");
    if (isFirstChunk) {
      els.outputContent.innerHTML = html;
    } else {
      els.outputContent.insertAdjacentHTML("beforeend", html);
    }
  } else if (plainText.trim()) {
    const html = isDiff(plainText)
      ? `<div class="md-content"><pre><code>${highlightDiff(plainText)}</code></pre></div>`
      : `<div class="md-content"><pre><code>${escapeHtml(plainText)}</code></pre></div>`;
    if (isFirstChunk) {
      els.outputContent.innerHTML = html;
    } else {
      els.outputContent.insertAdjacentHTML("beforeend", html);
    }
  } else if (isFirstChunk) {
    els.outputContent.innerHTML = "";
  }

  updateLoadMoreControl(state.selectedFile);
}

async function loadFileContent(id) {
  if (!id) return;
  const token = ++state.loadToken;
  const loadedState = state.fileLoadState[id];
  if (loadedState?.done && state.fileContents[id]) {
    renderContent();
    return;
  }
  if (loadedState && state.fileContents[id]) {
    renderContent();
    return;
  }

  if (state.selectedFile === id) {
    els.outputContent.innerHTML = `<div class="empty-state" style="height: 120px">Loading...</div>`;
  }

  const initialFile = state.files.find((f) => f.id === id);
  if (initialFile?.contentLoading?.mode !== "chunked") {
    await loadFullFileContent(id, token);
    return;
  }

  state.fileContents[id] = "";
  state.fileLoadState[id] = { offset: 0, done: false, pendingLine: "", loading: false };
  resetBlockCounter();
  resetCodexState();

  await loadNextFileChunk(id, token, INITIAL_CHUNK_SIZE);
}

async function loadNextFileChunk(id, token = state.loadToken, limit = null) {
  const loadState = state.fileLoadState[id];
  if (!loadState || loadState.done || loadState.loading) return;
  if (state.selectedFile !== id || state.loadToken !== token) return;

  const file = state.files.find((f) => f.id === id);
  const loading = file?.contentLoading || {};
  const requestedLimit = limit || loading.chunkSize || INITIAL_CHUNK_SIZE;
  const chunkSize = `&limit=${encodeURIComponent(requestedLimit)}`;
  const endpoint =
    loading.mode === "chunked" && loading.endpoint
      ? loading.endpoint
      : `/api/files/${encodeURIComponent(id)}/chunk`;
  const separator = endpoint.includes("?") ? "&" : "?";

  loadState.loading = true;
  updateLoadMoreControl(id);

  let data;
  try {
    const res = await fetch(
      `${endpoint}${separator}offset=${loadState.offset}${chunkSize}`,
    );
    if (!res.ok) throw new Error(`Failed to load ${id}`);
    data = await res.json();
  } catch (err) {
    console.error(err);
    loadState.loading = false;
    if (state.selectedFile === id && state.loadToken === token) {
      els.outputContent.innerHTML = `<div class="empty-state" style="height: 120px">Unable to load log content</div>`;
    }
    return;
  }

  if (state.selectedFile !== id || state.loadToken !== token) {
    loadState.loading = false;
    return;
  }

  state.fileContents[id] += data.content || "";
  loadState.offset = data.nextOffset;
  loadState.done = data.done;
  loadState.loading = false;

  if (file) {
    const previousPromptPreview = file.promptPreview;
    file.size = data.size;
    file.modified = data.modified;
    file.promptPreview = data.promptPreview || data.title || file.promptPreview;
    file.imagePreviews = data.imagePreviews || file.imagePreviews;
    file.contentLoading = data.contentLoading || file.contentLoading;
    file.source = data.source || file.source;
    if (file.promptPreview !== previousPromptPreview) renderFileList();
  }

  try {
    renderChunk(data.content || "", file, data.offset === 0, loadState, data.done);
  } catch (err) {
    console.error(err);
    if (state.selectedFile === id && state.loadToken === token) {
      els.outputContent.innerHTML = `<div class="empty-state" style="height: 120px">Unable to render log content</div>`;
    }
    return;
  }

  if (state.selectedFile === id) {
    const loadedLabel = data.done
      ? "fully loaded"
      : `${formatSize(data.nextOffset)} loaded`;
    els.contentMeta.textContent = `${formatSize(data.size)} | ${formatTime(data.modified)} | ${loadedLabel}`;
  }
}

function loadMoreSelected() {
  if (!state.selectedFile) return;
  loadNextFileChunk(state.selectedFile);
}

async function loadFullFileContent(id, token) {
  let data;
  try {
    const res = await fetch(`/api/files/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`Failed to load ${id}`);
    data = await res.json();
  } catch (err) {
    console.error(err);
    if (state.selectedFile === id && state.loadToken === token) {
      els.outputContent.innerHTML = `<div class="empty-state" style="height: 120px">Unable to load log content</div>`;
    }
    return;
  }

  if (state.selectedFile !== id || state.loadToken !== token) return;

  state.fileContents[id] = data.content || "";
  state.fileLoadState[id] = { offset: data.size || 0, done: true };
  const file = state.files.find((f) => f.id === id);
  if (file) {
    const previousPromptPreview = file.promptPreview;
    file.size = data.size;
    file.modified = data.modified;
    file.promptPreview = data.promptPreview || data.title || file.promptPreview;
    file.imagePreviews = data.imagePreviews || file.imagePreviews;
    file.contentLoading = data.contentLoading || file.contentLoading;
    file.source = data.source || file.source;
    if (file.promptPreview !== previousPromptPreview) renderFileList();
  }

  try {
    renderContent();
  } catch (err) {
    console.error(err);
    if (state.selectedFile === id && state.loadToken === token) {
      els.outputContent.innerHTML = `<div class="empty-state" style="height: 120px">Unable to render log content</div>`;
    }
  }
}

// --- Actions ---

function selectFile(id) {
  state.selectedFile = id;
  state.scrollLazyLoadArmed = false;
  const file = state.files.find((f) => f.id === id);
  if (file) file.hasUpdate = false;
  history.replaceState(null, "", "/" + id);
  renderFileList();
  renderContent();
  loadFileContent(id);
}

function sortFiles() {
  state.files.sort((a, b) => b.modified - a.modified);
}

function updateSourceLabel(data) {
  return data.source === "codex"
    ? "Codex"
    : data.source === "claude-project"
      ? "Claude Project"
      : "Claude";
}

async function loadInitialFiles() {
  const res = await fetch("/api/files");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  els.tasksDir.textContent =
    [data.tasksDir, data.claudeProjectsDir, data.codexDir]
      .filter(Boolean)
      .join(" | ") ||
    "Not detected";
  state.files = data.files.map((f) => ({ ...f, hasUpdate: false }));
  sortFiles();
  renderFileList();

  const urlId = location.pathname.slice(1);
  const target = urlId && state.files.some((f) => f.id === urlId) ? urlId : null;
  if (!state.selectedFile && target) {
    selectFile(target);
  } else if (!state.selectedFile && state.files.length > 0) {
    selectFile(state.files[0].id);
  } else {
    renderContent();
  }
}

function cleanForCopy(content) {
  if (!content) return "";
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        const evt = JSON.parse(line);
        const p = evt.payload;
        if (!p) return JSON.stringify(evt);

        // Drop entire noise-only events
        if (p.type === "token_count") return null;
        if (p.type === "agent_message") return null;
        if (p.type === "agent_reasoning") return null;

        // session_meta: keep only useful fields
        if (evt.type === "session_meta") {
          evt.payload = {
            originator: p.originator,
            cli_version: p.cli_version,
            model_provider: p.model_provider,
            cwd: p.cwd,
            git: p.git ? { branch: p.git.branch } : undefined,
          };
          return JSON.stringify(evt);
        }

        // turn_context: keep model + effort only
        if (evt.type === "turn_context") {
          evt.payload = { model: p.model, effort: p.effort };
          return JSON.stringify(evt);
        }

        // task_started: drop noisy fields
        if (p.type === "task_started") {
          delete p.model_context_window;
          delete p.collaboration_mode_kind;
        }

        // reasoning: drop encrypted_content
        delete p.encrypted_content;
        // function_call / function_call_output: drop call_id
        delete p.call_id;
        // drop turn_id everywhere in payload
        delete p.turn_id;

        return JSON.stringify(evt);
      } catch {
        return line;
      }
    })
    .filter(Boolean)
    .join("\n");
}

function copyFileContent() {
  const content = state.fileContents[state.selectedFile];
  if (!content) return;
  const cleaned = cleanForCopy(content);
  navigator.clipboard
    .writeText(cleaned)
    .then(() => showToast("Copied (cleaned)", "success"));
}

async function copySelectedFilePath() {
  const fileId = state.selectedFile;
  if (!fileId) return;
  els.copyPathBtn.disabled = true;
  try {
    const res = await fetch(
      `/api/files/${encodeURIComponent(fileId)}/temp-copy`,
      {
        method: "POST",
      },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Unable to copy file");
    const clipboardPath = data.tempPath || data.repoPath;
    if (!clipboardPath) throw new Error("Temp path missing");
    await navigator.clipboard.writeText(clipboardPath);
    showToast("Copied temp path", "success");
  } catch (err) {
    console.error(err);
    showToast("Temp copy failed", "error");
  } finally {
    els.copyPathBtn.disabled = false;
  }
}

function copyTasksDir() {
  const text = els.tasksDir.textContent;
  if (!text || text === "Detecting...") return;
  navigator.clipboard
    .writeText(text)
    .then(() => showToast("Copied", "success"));
}

async function refresh() {
  try {
    const res = await fetch("/api/refresh", { method: "POST" });
    const data = await res.json();
    els.tasksDir.textContent =
      [data.tasksDir, data.claudeProjectsDir, data.codexDir]
        .filter(Boolean)
        .join(" | ") ||
      "Not detected";
    state.files = data.files.map((f) => ({
      ...f,
      hasUpdate: state.selectedFile !== f.id && state.files.find((old) => old.id === f.id)?.hasUpdate,
    }));
    sortFiles();
    renderFileList();
    if (state.selectedFile && !state.files.some((f) => f.id === state.selectedFile)) {
      state.selectedFile = state.files[0]?.id || null;
    }
    if (state.selectedFile && !Object.prototype.hasOwnProperty.call(state.fileContents, state.selectedFile)) {
      loadFileContent(state.selectedFile);
    } else {
      renderContent();
    }
    showToast("Refreshed", "success");
    if (state.eventSource) state.eventSource.close();
    connectSSE();
  } catch {
    showToast("Refresh failed", "error");
  }
}

// --- Auto-scroll tracking ---

function armScrollLazyLoad() {
  state.scrollLazyLoadArmed = true;
}

els.outputContainer.addEventListener("wheel", armScrollLazyLoad, { passive: true });
els.outputContainer.addEventListener("touchmove", armScrollLazyLoad, { passive: true });
els.outputContainer.addEventListener("pointerdown", armScrollLazyLoad);
els.outputContainer.addEventListener("keydown", (e) => {
  if (["ArrowDown", "End", "PageDown", " "].includes(e.key)) {
    armScrollLazyLoad();
  }
});

els.outputContainer.addEventListener("scroll", () => {
  const el = els.outputContainer;
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  state.userScrolledUp = distanceFromBottom > 50;
  if (
    state.selectedFile &&
    state.scrollLazyLoadArmed &&
    distanceFromBottom < SCROLL_LOAD_THRESHOLD
  ) {
    loadNextFileChunk(state.selectedFile);
  }
});

// --- SSE Connection ---

function connectSSE() {
  setConnectionStatus("reconnecting");
  state.eventSource = new EventSource("/api/events");

  state.eventSource.addEventListener("init", (e) => {
    const data = JSON.parse(e.data);
    els.tasksDir.textContent =
      [data.tasksDir, data.claudeProjectsDir, data.codexDir]
        .filter(Boolean)
        .join(" | ") ||
      "Not detected";
    const existing = new Map(state.files.map((f) => [f.id, f]));
    state.files = data.files.map((f) => ({
      ...f,
      hasUpdate: existing.get(f.id)?.hasUpdate || false,
    }));
    sortFiles();
    renderFileList();
    if (state.selectedFile && !state.files.some((f) => f.id === state.selectedFile)) {
      state.selectedFile = state.files[0]?.id || null;
    }
    if (state.selectedFile) renderContent();
  });

  state.eventSource.addEventListener("file-content", (e) => {
    const data = JSON.parse(e.data);
    if (data.full) {
      state.fileContents[data.id] = data.content;
    } else {
      state.fileContents[data.id] =
        (state.fileContents[data.id] || "") + data.content;
    }
    if (state.selectedFile === data.id) renderContent();
  });

  state.eventSource.addEventListener("file-added", (e) => {
    const data = JSON.parse(e.data);
    state.files = state.files.filter((f) => f.id !== data.id);
    state.files.unshift({
      id: data.id,
      filename: data.filename || data.id,
      displayLabel: data.displayLabel,
      title: data.title,
      filePath: data.filePath,
      size: data.size,
      modified: data.modified,
      promptPreview: data.promptPreview,
      imagePreviews: data.imagePreviews,
      contentLoading: data.contentLoading,
      project: data.project,
      hasUpdate: true,
      source: data.source || "claude",
    });
    sortFiles();
    renderFileList();
    showToast(`New task: ${updateSourceLabel(data)}`, "info");
    if (!state.selectedFile) selectFile(data.id);
  });

  state.eventSource.addEventListener("file-update", (e) => {
    const data = JSON.parse(e.data);
    state.fileContents[data.id] =
      (state.fileContents[data.id] || "") + data.content;
    const file = state.files.find((f) => f.id === data.id);
    if (file) {
      file.filename = data.filename || file.filename;
      file.displayLabel = data.displayLabel || file.displayLabel;
      file.title = data.title || file.title;
      file.filePath = data.filePath || file.filePath;
      file.size = data.size;
      file.modified = data.modified;
      file.promptPreview = data.promptPreview || data.title || file.promptPreview;
      file.imagePreviews = data.imagePreviews || file.imagePreviews;
      file.contentLoading = data.contentLoading || file.contentLoading;
      file.project = data.project || file.project;
      if (state.selectedFile !== data.id) file.hasUpdate = true;
      sortFiles();
    } else {
      state.files.unshift({
        id: data.id,
        filename: data.filename || data.id,
        displayLabel: data.displayLabel,
        title: data.title,
        filePath: data.filePath,
        size: data.size,
        modified: data.modified,
        hasUpdate: state.selectedFile !== data.id,
        source: data.source || "claude",
        promptPreview: data.promptPreview || data.title,
        imagePreviews: data.imagePreviews,
        contentLoading: data.contentLoading,
        project: data.project,
      });
      sortFiles();
    }
    renderFileList();
    if (state.selectedFile === data.id) renderContent();
  });

  state.eventSource.addEventListener("file-removed", (e) => {
    const data = JSON.parse(e.data);
    state.files = state.files.filter((f) => f.id !== data.id);
    delete state.fileContents[data.id];
    if (state.selectedFile === data.id) {
      state.selectedFile = state.files.length > 0 ? state.files[0].id : null;
    }
    renderFileList();
    renderContent();
  });

  state.eventSource.onopen = () => setConnectionStatus("connected");
  state.eventSource.onerror = () => setConnectionStatus("reconnecting");
}

// --- Search ---

let searchDebounceTimer = null;

function clearSearchHighlights() {
  const marks = els.outputContent.querySelectorAll("mark.search-highlight");
  for (const mark of marks) {
    const parent = mark.parentNode;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  }
  state.searchMatches = [];
  state.searchIndex = -1;
  els.searchCount.textContent = "";
}

function expandCollapsedParents(el) {
  // Walk up from the element and open any collapsed block that hides it
  let node = el.parentElement;
  while (node && node !== els.outputContent) {
    if (
      node.classList.contains("tool-body") ||
      node.classList.contains("tool-result-body") ||
      node.classList.contains("json-spoiler-body")
    ) {
      if (!node.classList.contains("open")) {
        node.classList.add("open");
        const chevron = document.getElementById("chev-" + node.id);
        if (chevron) chevron.classList.add("open");
      }
    }
    node = node.parentElement;
  }
}

function performSearch(query) {
  clearSearchHighlights();
  state.searchQuery = query;
  if (!query || query.length < 2) return;

  const lowerQuery = query.toLowerCase();
  const container = els.outputContent;

  // Walk all text nodes, skip only JSON spoiler bodies (raw JSON) and script/style
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(".json-spoiler-body")) return NodeFilter.FILTER_REJECT;
      if (parent.tagName === "SCRIPT" || parent.tagName === "STYLE")
        return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.textContent.toLowerCase().includes(lowerQuery)) {
      textNodes.push(node);
    }
  }

  // Wrap matches in <mark> tags
  for (const textNode of textNodes) {
    const text = textNode.textContent;
    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    const lowerText = text.toLowerCase();
    let idx = lowerText.indexOf(lowerQuery, lastIndex);

    while (idx !== -1) {
      if (idx > lastIndex) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex, idx)));
      }
      const mark = document.createElement("mark");
      mark.className = "search-highlight";
      mark.textContent = text.slice(idx, idx + query.length);
      frag.appendChild(mark);
      lastIndex = idx + query.length;
      idx = lowerText.indexOf(lowerQuery, lastIndex);
    }
    if (lastIndex < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    textNode.parentNode.replaceChild(frag, textNode);
  }

  state.searchMatches = Array.from(
    container.querySelectorAll("mark.search-highlight"),
  );

  if (state.searchMatches.length > 0) {
    state.searchIndex = 0;
    state.searchMatches[0].classList.add("active");
    expandCollapsedParents(state.searchMatches[0]);
    // Use requestAnimationFrame so the DOM layout updates before scrolling
    requestAnimationFrame(() => {
      state.searchMatches[0].scrollIntoView({ block: "center" });
    });
    els.searchCount.textContent = `1/${state.searchMatches.length}`;
  } else {
    els.searchCount.textContent = "0/0";
  }
}

function searchNav(direction) {
  if (state.searchMatches.length === 0) return;
  state.searchMatches[state.searchIndex]?.classList.remove("active");
  state.searchIndex =
    (state.searchIndex + direction + state.searchMatches.length) %
    state.searchMatches.length;
  const match = state.searchMatches[state.searchIndex];
  match.classList.add("active");
  expandCollapsedParents(match);
  requestAnimationFrame(() => {
    match.scrollIntoView({ block: "center" });
  });
  els.searchCount.textContent = `${state.searchIndex + 1}/${state.searchMatches.length}`;
}

function clearSearch() {
  els.searchInput.value = "";
  state.searchQuery = "";
  clearSearchHighlights();
}

// Search input events
els.searchInput.addEventListener("input", (e) => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    performSearch(e.target.value.trim());
  }, 200);
});

els.searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    searchNav(e.shiftKey ? -1 : 1);
  }
  if (e.key === "Escape") {
    e.preventDefault();
    clearSearch();
    els.searchInput.blur();
  }
});

// Ctrl+F / Cmd+F to focus search
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    e.preventDefault();
    els.searchInput.focus();
    els.searchInput.select();
  }
});

// --- Init ---

initMarkdown();
loadInitialFiles()
  .then(() => connectSSE())
  .catch(() => {
    showToast("Initial load failed", "error");
    setConnectionStatus("disconnected");
  });
