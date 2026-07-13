import express from "express";
import { watch } from "chokidar";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import "./public/export-cleaner.js";

const { cleanForCopy } = globalThis.AgentViewerExportCleaner;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 60653;
const metadataCacheDir = path.join(__dirname, ".cache");
const metadataCachePath = path.join(metadataCacheDir, "files-metadata.json");
const tempDir = path.join(__dirname, "temp");
const DEFAULT_CHUNK_SIZE = 512 * 1024;
const MAX_CHUNK_SIZE = 2 * 1024 * 1024;
const MAX_LIVE_UPDATE_BYTES = MAX_CHUNK_SIZE;

// --- Auto-detect Claude Code temp directory ---

function findClaudeTasksDir() {
  const uid = os.userInfo().uid;
  const tmpBase = "/private/tmp";
  const pattern = `claude-${uid}`;
  const claudeDir = path.join(tmpBase, pattern);

  if (!fs.existsSync(claudeDir)) {
    console.warn(`Claude temp dir not found: ${claudeDir}`);
    return null;
  }

  // Find project subdirectories containing tasks/
  const entries = fs.readdirSync(claudeDir);
  const projectDirs = [];

  for (const entry of entries) {
    const tasksPath = path.join(claudeDir, entry, "tasks");
    if (fs.existsSync(tasksPath) && fs.statSync(tasksPath).isDirectory()) {
      projectDirs.push({ project: entry, tasksPath });
    }
  }

  if (projectDirs.length === 0) {
    console.warn(`No tasks/ directories found in ${claudeDir}`);
    return null;
  }

  // Use the first one (typically only one project active)
  const selected = projectDirs[0];
  console.log(`Auto-detected tasks dir: ${selected.tasksPath}`);
  if (projectDirs.length > 1) {
    console.log(
      `Other projects found: ${projectDirs
        .slice(1)
        .map((d) => d.project)
        .join(", ")}`,
    );
  }

  return selected.tasksPath;
}

// --- Auto-detect Codex CLI sessions directory ---

function findCodexSessionsDir() {
  const codexDir = path.join(os.homedir(), ".codex", "sessions");
  if (!fs.existsSync(codexDir)) {
    console.warn(`Codex sessions dir not found: ${codexDir}`);
    return null;
  }
  console.log(`Auto-detected Codex sessions dir: ${codexDir}`);
  return codexDir;
}

function codexFileId(filePath) {
  const name = path.basename(filePath, ".jsonl");
  // rollout-2026-03-05T20-47-16-019cbfc1-36cf-7d20-96cb-46dde459a899
  // Extract UUID portion after the ISO timestamp
  const stripped = name.replace("rollout-", "");
  const match = stripped.match(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/);
  return "codex-" + (match ? match[1] : stripped);
}

function safeTempFileName(fileId, filePath) {
  const baseName = path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeId = String(fileId || "file")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 96);
  return `${safeId}-${baseName}`;
}

function compactFileName(fileName) {
  const extension = path.extname(fileName);
  const baseName = extension
    ? fileName.slice(0, -extension.length)
    : fileName;
  if (baseName.length <= 7) return fileName;
  return `${baseName.slice(-7)}${extension}`;
}

function compactFilePath(filePath) {
  const parentDir = path.dirname(filePath);
  const pathRoot = path.parse(parentDir).root;
  const relativeParts = path
    .relative(pathRoot, parentDir)
    .split(path.sep)
    .filter(Boolean);
  const visiblePrefix = relativeParts[0]
    ? `${pathRoot}${relativeParts[0]}`
    : pathRoot;
  return `${visiblePrefix}...${compactFileName(path.basename(filePath))}`;
}

function copyFileToTemp(fileId, filePath) {
  fs.mkdirSync(tempDir, { recursive: true });
  const tempFileName = safeTempFileName(fileId, filePath);
  const tempPath = path.join(tempDir, tempFileName);
  const content = fs.readFileSync(filePath, "utf8");
  fs.writeFileSync(tempPath, cleanForCopy(content), "utf8");
  return {
    tempPath,
    repoPath: path.relative(__dirname, tempPath),
    compactPath: compactFilePath(tempPath),
  };
}

// --- File offset tracking for tail-f ---

const fileOffsets = new Map();
const filePathMap = new Map();
const fileMetaMap = new Map();
const promptPreviewCache = new Map();
let metadataCacheDirty = false;
const sseClients = new Set();

function loadMetadataCache() {
  try {
    const raw = fs.readFileSync(metadataCachePath, "utf8");
    const parsed = JSON.parse(raw);
    const entries = parsed.files && typeof parsed.files === "object"
      ? parsed.files
      : parsed;
    for (const [filePath, entry] of Object.entries(entries || {})) {
      if (!entry || typeof entry !== "object") continue;
      const normalizedPreview = normalizePromptPreview(entry.preview);
      if (normalizedPreview !== entry.preview) metadataCacheDirty = true;
      promptPreviewCache.set(filePath, entry);
      entry.preview = normalizedPreview;
    }
    console.log(`Loaded ${promptPreviewCache.size} metadata cache entries`);
    saveMetadataCache();
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`Unable to load metadata cache: ${err.message}`);
    }
  }
}

function saveMetadataCache() {
  if (!metadataCacheDirty) return;
  try {
    fs.mkdirSync(metadataCacheDir, { recursive: true });
    const files = Object.fromEntries(promptPreviewCache.entries());
    fs.writeFileSync(
      metadataCachePath,
      JSON.stringify(
        {
          version: 1,
          generatedAt: new Date().toISOString(),
          files,
        },
        null,
        2,
      ),
    );
    metadataCacheDirty = false;
  } catch (err) {
    console.warn(`Unable to save metadata cache: ${err.message}`);
  }
}

function removeMetadataCacheEntry(filePath) {
  if (promptPreviewCache.delete(filePath)) {
    metadataCacheDirty = true;
    saveMetadataCache();
  }
}

function normalizePromptPreview(text) {
  return String(text || "")
    .replace(/<ide_[^>]+>[\s\S]*?<\/ide_[^>]+>/g, " ")
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, " [image] ")
    .replace(/<image\s*\/>/gi, " [image] ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstTextFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" || block?.type === "input_text")
    .map((block) => block.text)
    .filter(Boolean)
    .join(" ");
}

function userPromptFromEvent(evt) {
  const payload = evt.payload;

  if (evt.type === "event_msg" && payload?.type === "user_message") {
    return payload.message || payload.text_elements?.join(" ");
  }

  if (
    evt.type === "response_item" &&
    payload?.type === "message" &&
    payload.role === "user"
  ) {
    const text = firstTextFromContent(payload.content);
    if (text.startsWith("# AGENTS.md instructions")) return "";
    if (text.startsWith("<environment_context>")) return "";
    return text;
  }

  if (evt.type === "user") {
    return firstTextFromContent(evt.message?.content);
  }

  return "";
}

function imageRefsFromEvent(evt) {
  const payload = evt.payload;
  const refs = [];

  if (evt.type === "event_msg" && payload?.type === "user_message") {
    refs.push(...(payload.images || []));
    refs.push(...(payload.local_images || []));
  }

  if (
    evt.type === "response_item" &&
    payload?.type === "message" &&
    payload.role === "user" &&
    Array.isArray(payload.content)
  ) {
    for (const block of payload.content) {
      if (block?.type === "input_image" && block.image_url) refs.push(block.image_url);
      if (block?.type === "local_image" && block.path) refs.push(block.path);
    }
  }

  return refs.filter(Boolean);
}

function imageCountFromRawPromptLine(line) {
  const imagesMatch = line.match(/"images"\s*:\s*\[/);
  if (!imagesMatch) return 0;
  const beforeLocalImages = line.slice(imagesMatch.index, line.indexOf('"local_images"', imagesMatch.index));
  const dataUrlMatches = beforeLocalImages.match(/data:image\//g) || [];
  return dataUrlMatches.length;
}

function promptMessageFromRawLine(line) {
  const match = line.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!match) return "";
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

function scanPromptMetadata(filePath, stats) {
  let preview = "";
  let imageCount = 0;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const maxBytes = Math.min(stats.size, 2 * 1024 * 1024);
      const buffer = Buffer.alloc(maxBytes);
      const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
      const lines = buffer.toString("utf8", 0, bytesRead).split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          preview = normalizePromptPreview(userPromptFromEvent(evt));
          if (preview) {
            imageCount = imageRefsFromEvent(evt).length;
            break;
          }
        } catch {
          if (line.includes('"type":"user_message"')) {
            preview = normalizePromptPreview(promptMessageFromRawLine(line));
            imageCount = imageCountFromRawPromptLine(line);
            if (preview || imageCount) break;
          }
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    preview = "";
  }
  return { preview, imageCount };
}

function getPromptMetadata(filePath, stats) {
  const cached = promptPreviewCache.get(filePath);
  if (
    cached &&
    cached.size === stats.size &&
    cached.modified === stats.mtimeMs
  ) {
    const normalizedPreview = normalizePromptPreview(cached.preview);
    if (
      cached.imageCount !== undefined &&
      !(normalizedPreview.includes("[image]") && cached.imageCount === 0)
    ) {
      if (normalizedPreview !== cached.preview) {
        cached.preview = normalizedPreview;
        metadataCacheDirty = true;
        saveMetadataCache();
      }
      return {
        preview: normalizedPreview,
        imageCount: cached.imageCount || 0,
      };
    }
    if (normalizedPreview !== cached.preview) {
      cached.preview = normalizedPreview;
      metadataCacheDirty = true;
    }
  }

  const metadata = scanPromptMetadata(filePath, stats);

  const entry = {
    size: stats.size,
    modified: stats.mtimeMs,
    preview: metadata.preview,
    imageCount: metadata.imageCount,
  };
  promptPreviewCache.set(filePath, entry);
  metadataCacheDirty = true;
  return metadata;
}

function buildFileMetadata({
  id,
  filename,
  displayLabel,
  filePath,
  stats,
  source,
  project,
}) {
  const promptMetadata = getPromptMetadata(filePath, stats);
  const fallbackTitle = displayLabel || filename || id;
  const title = promptMetadata.preview || fallbackTitle;
  return {
    id,
    filename,
    displayLabel,
    title,
    filePath,
    size: stats.size,
    modified: stats.mtimeMs,
    promptPreview: promptMetadata.preview,
    imagePreviews: Array.from({ length: promptMetadata.imageCount }, (_, index) => ({
      index,
      endpoint: `/api/files/${encodeURIComponent(id)}/image/${index}`,
    })),
    contentLoading: {
      mode: "chunked",
      chunkSize: DEFAULT_CHUNK_SIZE,
      endpoint: `/api/files/${encodeURIComponent(id)}/chunk`,
    },
    project,
    source,
  };
}

function getFileList(tasksDir) {
  if (!tasksDir || !fs.existsSync(tasksDir)) return [];

  return fs
    .readdirSync(tasksDir)
    .filter((f) => f.endsWith(".output"))
    .map((f) => {
      const filePath = path.join(tasksDir, f);
      const stats = fs.statSync(filePath);
      return buildFileMetadata({
        id: f.replace(".output", ""),
        filename: f,
        displayLabel: `${f.replace(".output", "")}.output`,
        filePath,
        source: "claude",
        stats,
      });
    })
    .sort((a, b) => b.modified - a.modified);
}

function claudeProjectFileId(projectName, fileName) {
  return `claude-project-${projectName}-${path.basename(fileName, ".jsonl")}`;
}

function getClaudeProjectsDir() {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsDir)) {
    console.warn(`Claude projects dir not found: ${projectsDir}`);
    return null;
  }
  console.log(`Auto-detected Claude projects dir: ${projectsDir}`);
  return projectsDir;
}

function getClaudeProjectFileList(projectsDir) {
  if (!projectsDir || !fs.existsSync(projectsDir)) return [];

  const files = [];
  let projectEntries;
  try {
    projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of projectEntries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(projectsDir, entry.name);
    let projectFiles;
    try {
      projectFiles = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const projectFile of projectFiles) {
      if (!projectFile.isFile() || !projectFile.name.endsWith(".jsonl")) {
        continue;
      }

      const filePath = path.join(projectDir, projectFile.name);
      try {
        const stats = fs.statSync(filePath);
        files.push(buildFileMetadata({
          id: claudeProjectFileId(entry.name, projectFile.name),
          filename: projectFile.name,
          displayLabel: `${entry.name}/${projectFile.name}`,
          filePath,
          project: entry.name,
          source: "claude-project",
          stats,
        }));
      } catch {
        // Skip unreadable files
      }
    }
  }

  return files.sort((a, b) => b.modified - a.modified);
}

function getCodexFileList(sessionsDir) {
  if (!sessionsDir || !fs.existsSync(sessionsDir)) return [];
  const files = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl"))
        continue;
      try {
        const stats = fs.statSync(full);
        const id = codexFileId(full);
        files.push(buildFileMetadata({
          id,
          filename: entry.name,
          displayLabel: entry.name,
          filePath: full,
          source: "codex",
          stats,
        }));
      } catch {
        // Skip unreadable files
      }
    }
  }
  walk(sessionsDir);
  return files.sort((a, b) => b.modified - a.modified);
}

function getAllFiles() {
  const claudeFiles = getFileList(tasksDir);
  const claudeProjectFiles = getClaudeProjectFileList(claudeProjectsDir);
  const codexFiles = getCodexFileList(codexDir);
  const all = [...claudeFiles, ...claudeProjectFiles, ...codexFiles].sort(
    (a, b) => b.modified - a.modified,
  );
  filePathMap.clear();
  fileMetaMap.clear();
  for (const f of all) {
    filePathMap.set(f.id, f.filePath);
    fileMetaMap.set(f.id, f);
    setFileOffsetIfUnknown(f.filePath, f.size);
  }
  saveMetadataCache();
  return all;
}

function toClientFile(file) {
  return {
    id: file.id,
    filename: file.filename,
    displayLabel: file.displayLabel,
    title: file.title,
    filePath: file.filePath,
    size: file.size,
    modified: file.modified,
    promptPreview: file.promptPreview,
    imagePreviews: file.imagePreviews,
    contentLoading: file.contentLoading,
    source: file.source,
    project: file.project,
  };
}

function readNewContent(filePath) {
  const hasOffset = fileOffsets.has(filePath);
  const lastOffset = hasOffset ? fileOffsets.get(filePath) : 0;
  let stats;

  try {
    stats = fs.statSync(filePath);
  } catch {
    fileOffsets.delete(filePath);
    return null;
  }

  if (!hasOffset) {
    fileOffsets.set(filePath, stats.size);
    return {
      content: "",
      skipped: stats.size > 0,
    };
  }

  // File was truncated — reset offset
  if (stats.size < lastOffset) {
    if (stats.size > MAX_LIVE_UPDATE_BYTES) {
      fileOffsets.set(filePath, stats.size);
      return {
        content: "",
        reset: true,
        skipped: true,
      };
    }

    fileOffsets.set(filePath, 0);
    return {
      content: readFullContent(filePath),
      reset: true,
    };
  }

  if (stats.size === lastOffset) return null;

  const bytesToRead = stats.size - lastOffset;
  if (bytesToRead > MAX_LIVE_UPDATE_BYTES) {
    fileOffsets.set(filePath, stats.size);
    return {
      content: "",
      skipped: true,
    };
  }

  const buffer = Buffer.alloc(bytesToRead);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, buffer.length, lastOffset);
  } finally {
    fs.closeSync(fd);
  }

  fileOffsets.set(filePath, stats.size);
  return {
    content: buffer.toString("utf8"),
  };
}

function readFullContent(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    fileOffsets.set(filePath, Buffer.byteLength(content, "utf8"));
    return content;
  } catch {
    return "";
  }
}

function setFileOffsetIfUnknown(filePath, size) {
  if (!fileOffsets.has(filePath)) fileOffsets.set(filePath, size);
}

function buildLiveUpdatePayload(metadata, update) {
  const payload = { ...metadata };
  if (update.reset) payload.contentReset = true;
  if (update.skipped) payload.contentSkipped = true;
  if (typeof update.content === "string") payload.content = update.content;
  return payload;
}

function resolveFilePath(id) {
  let filePath = filePathMap.get(id);
  if (!filePath && tasksDir) {
    filePath = path.join(tasksDir, `${id}.output`);
  }
  if (!filePath || !fs.existsSync(filePath)) return null;
  return filePath;
}

function readContentChunk(filePath, offset, limit) {
  const stats = fs.statSync(filePath);
  if (offset >= stats.size) {
    return {
      content: "",
      nextOffset: stats.size,
      done: true,
      size: stats.size,
      modified: stats.mtimeMs,
    };
  }

  const readStart = Math.max(0, offset);
  const fd = fs.openSync(filePath, "r");
  try {
    const chunks = [];
    let position = readStart;
    let totalBytes = 0;
    let foundNewline = false;

    while (position < stats.size && !foundNewline) {
      const targetBytes = totalBytes < limit
        ? limit - totalBytes
        : 64 * 1024;
      const buffer = Buffer.alloc(Math.min(targetBytes, stats.size - position));
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;

      const chunk = buffer.subarray(0, bytesRead);
      const newlineSearchStart = Math.max(0, limit - totalBytes);
      const newlineIndex = totalBytes + bytesRead >= limit
        ? chunk.indexOf(10, newlineSearchStart)
        : -1;

      if (newlineIndex === -1) {
        chunks.push(chunk);
        position += bytesRead;
        totalBytes += bytesRead;
      } else {
        const end = newlineIndex + 1;
        chunks.push(chunk.subarray(0, end));
        position += end;
        totalBytes += end;
        foundNewline = true;
      }
    }

    const content = Buffer.concat(chunks, totalBytes).toString("utf8");
    const nextOffset = readStart + Buffer.byteLength(content, "utf8");
    return {
      content,
      nextOffset,
      done: nextOffset >= stats.size,
      size: stats.size,
      modified: stats.mtimeMs,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function findPromptImageRef(filePath, imageIndex) {
  let seen = 0;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line);
      const preview = normalizePromptPreview(userPromptFromEvent(evt));
      if (!preview) continue;
      for (const ref of imageRefsFromEvent(evt)) {
        if (seen === imageIndex) return ref;
        seen += 1;
      }
      return null;
    } catch {
      // Ignore non-JSON or malformed lines while resolving images.
    }
  }
  return null;
}

function sendImageRef(res, ref) {
  if (!ref) return res.status(404).json({ error: "Image not found" });

  if (ref.startsWith("data:image/")) {
    const match = ref.match(/^data:(image\/[^;]+);base64,(.*)$/);
    if (!match) return res.status(400).json({ error: "Unsupported image data" });
    res.set("Content-Type", match[1]);
    res.set("Cache-Control", "public, max-age=3600");
    return res.send(Buffer.from(match[2], "base64"));
  }

  if (/^https?:\/\//.test(ref)) {
    return res.redirect(ref);
  }

  const imagePath = path.resolve(ref);
  if (!fs.existsSync(imagePath)) {
    return res.status(404).json({ error: "Image file not found" });
  }
  return res.sendFile(imagePath);
}

// --- SSE helpers ---

function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastSSE(event, data) {
  for (const client of sseClients) {
    try {
      sendSSE(client, event, data);
    } catch {
      sseClients.delete(client);
    }
  }
}

// --- Express app ---

const app = express();
app.use(express.static(path.join(__dirname, "public")));

let tasksDir = findClaudeTasksDir();
let claudeProjectsDir = getClaudeProjectsDir();
let codexDir = findCodexSessionsDir();
loadMetadataCache();

// REST: list files
app.get("/api/files", (req, res) => {
  const files = getAllFiles();
  res.json({
    tasksDir,
    claudeProjectsDir,
    codexDir,
    files: files.map(toClientFile),
  });
});

// REST: get single file content
app.get("/api/files/:id", (req, res) => {
  const filePath = resolveFilePath(req.params.id);
  if (!filePath)
    return res.status(404).json({ error: "File not found" });

  const content = fs.readFileSync(filePath, "utf8");
  const stats = fs.statSync(filePath);
  fileOffsets.set(filePath, Buffer.byteLength(content, "utf8"));
  const source = fileMetaMap.get(req.params.id)?.source ||
    (req.params.id.startsWith("codex-") ? "codex" : "claude");
  const metadata = buildFileMetadata({
    id: req.params.id,
    filename: path.basename(filePath),
    displayLabel: fileMetaMap.get(req.params.id)?.displayLabel,
    project: fileMetaMap.get(req.params.id)?.project,
    filePath,
    stats,
    source,
  });
  saveMetadataCache();
  res.json({
    ...metadata,
    content: cleanForCopy(content),
  });
});

// REST: get one content chunk for large logs
app.get("/api/files/:id/chunk", (req, res) => {
  const filePath = resolveFilePath(req.params.id);
  if (!filePath)
    return res.status(404).json({ error: "File not found" });

  const offset = Math.max(0, Number.parseInt(req.query.offset || "0", 10) || 0);
  const requestedLimit =
    Number.parseInt(req.query.limit || String(DEFAULT_CHUNK_SIZE), 10) ||
    DEFAULT_CHUNK_SIZE;
  const limit = Math.min(Math.max(1024, requestedLimit), MAX_CHUNK_SIZE);

  const stats = fs.statSync(filePath);
  const source = fileMetaMap.get(req.params.id)?.source ||
    (req.params.id.startsWith("codex-") ? "codex" : "claude");
  const metadata = buildFileMetadata({
    id: req.params.id,
    filename: path.basename(filePath),
    displayLabel: fileMetaMap.get(req.params.id)?.displayLabel,
    project: fileMetaMap.get(req.params.id)?.project,
    filePath,
    stats,
    source,
  });
  const chunk = readContentChunk(filePath, offset, limit);
  const content = cleanForCopy(chunk.content);
  fileOffsets.set(filePath, chunk.nextOffset);
  saveMetadataCache();

  res.json({
    ...metadata,
    content: content ? `${content}\n` : "",
    offset,
    nextOffset: chunk.nextOffset,
    done: chunk.done,
  });
});

// REST: get prompt image preview
app.get("/api/files/:id/image/:index", (req, res) => {
  const filePath = resolveFilePath(req.params.id);
  if (!filePath)
    return res.status(404).json({ error: "File not found" });

  const imageIndex = Math.max(0, Number.parseInt(req.params.index || "0", 10) || 0);
  const ref = findPromptImageRef(filePath, imageIndex);
  return sendImageRef(res, ref);
});

// REST: copy selected source log into the viewer temp folder
app.post("/api/files/:id/temp-copy", (req, res) => {
  const filePath = resolveFilePath(req.params.id);
  if (!filePath)
    return res.status(404).json({ error: "File not found" });

  try {
    const copied = copyFileToTemp(req.params.id, filePath);
    res.json(copied);
  } catch (err) {
    res.status(500).json({ error: err.message || "Unable to copy file" });
  }
});

// REST: refresh detection
app.post("/api/refresh", (req, res) => {
  tasksDir = findClaudeTasksDir();
  claudeProjectsDir = getClaudeProjectsDir();
  codexDir = findCodexSessionsDir();
  const files = getAllFiles();
  res.json({
    tasksDir,
    claudeProjectsDir,
    codexDir,
    files: files.map(toClientFile),
  });
});

// SSE: realtime events
app.get("/api/events", (req, res) => {
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  // Send initial file list (both sources)
  const files = getAllFiles();
  sendSSE(res, "init", {
    tasksDir,
    claudeProjectsDir,
    codexDir,
    files: files.map(toClientFile),
  });

  sseClients.add(res);

  req.on("close", () => {
    sseClients.delete(res);
  });

  // Keep-alive ping every 30s
  const keepAlive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(keepAlive);
      sseClients.delete(res);
    }
  }, 30000);

  req.on("close", () => clearInterval(keepAlive));
});

// --- Chokidar watchers ---

function startWatcher() {
  if (!tasksDir) {
    console.log(
      "No tasks directory — watching will start when directory is detected",
    );
    // Retry detection every 5s
    const retryInterval = setInterval(() => {
      tasksDir = findClaudeTasksDir();
      if (tasksDir) {
        clearInterval(retryInterval);
        startWatcher();
        broadcastSSE("init", {
          tasksDir,
          claudeProjectsDir,
          codexDir,
          files: getAllFiles().map(toClientFile),
        });
      }
    }, 5000);
    return;
  }

  const watcher = watch(tasksDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  watcher.on("add", (filePath) => {
    if (!filePath.endsWith(".output")) return;
    const id = path.basename(filePath, ".output");
    filePathMap.set(id, filePath);
    const stats = fs.statSync(filePath);
    setFileOffsetIfUnknown(filePath, stats.size);
    const metadata = buildFileMetadata({
      id,
      filename: path.basename(filePath),
      displayLabel: `${id}.output`,
      filePath,
      stats,
      source: "claude",
    });
    fileMetaMap.set(id, metadata);
    saveMetadataCache();
    broadcastSSE("file-added", metadata);
  });

  watcher.on("change", (filePath) => {
    if (!filePath.endsWith(".output")) return;
    const id = path.basename(filePath, ".output");
    const update = readNewContent(filePath);
    if (update) {
      const stats = fs.statSync(filePath);
      const metadata = buildFileMetadata({
        id,
        filename: path.basename(filePath),
        displayLabel: `${id}.output`,
        filePath,
        stats,
        source: "claude",
      });
      fileMetaMap.set(id, metadata);
      saveMetadataCache();
      broadcastSSE("file-update", buildLiveUpdatePayload(metadata, update));
    }
  });

  watcher.on("unlink", (filePath) => {
    if (!filePath.endsWith(".output")) return;
    const id = path.basename(filePath, ".output");
    fileOffsets.delete(filePath);
    filePathMap.delete(id);
    fileMetaMap.delete(id);
    removeMetadataCacheEntry(filePath);
    broadcastSSE("file-removed", { id });
  });

  console.log(`Watching Claude: ${tasksDir}`);
}

function startClaudeProjectsWatcher() {
  if (!claudeProjectsDir) {
    console.log("No Claude projects directory found");
    return;
  }

  const watcher = watch(claudeProjectsDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  watcher.on("add", (filePath) => {
    if (!filePath.endsWith(".jsonl")) return;
    const projectName = path.basename(path.dirname(filePath));
    const id = claudeProjectFileId(projectName, path.basename(filePath));
    const stats = fs.statSync(filePath);
    setFileOffsetIfUnknown(filePath, stats.size);
    const meta = buildFileMetadata({
      id,
      filename: path.basename(filePath),
      displayLabel: `${projectName}/${path.basename(filePath)}`,
      filePath,
      project: projectName,
      source: "claude-project",
      stats,
    });
    filePathMap.set(id, filePath);
    fileMetaMap.set(id, meta);
    saveMetadataCache();
    broadcastSSE("file-added", meta);
  });

  watcher.on("change", (filePath) => {
    if (!filePath.endsWith(".jsonl")) return;
    const projectName = path.basename(path.dirname(filePath));
    const id = claudeProjectFileId(projectName, path.basename(filePath));
    const update = readNewContent(filePath);
    if (update) {
      const stats = fs.statSync(filePath);
      const meta = buildFileMetadata({
        id,
        filename: path.basename(filePath),
        displayLabel: `${projectName}/${path.basename(filePath)}`,
        filePath,
        project: projectName,
        source: "claude-project",
        stats,
      });
      fileMetaMap.set(id, meta);
      filePathMap.set(id, filePath);
      saveMetadataCache();
      broadcastSSE("file-update", buildLiveUpdatePayload(meta, update));
    }
  });

  watcher.on("unlink", (filePath) => {
    if (!filePath.endsWith(".jsonl")) return;
    const projectName = path.basename(path.dirname(filePath));
    const id = claudeProjectFileId(projectName, path.basename(filePath));
    fileOffsets.delete(filePath);
    filePathMap.delete(id);
    fileMetaMap.delete(id);
    removeMetadataCacheEntry(filePath);
    broadcastSSE("file-removed", { id });
  });

  console.log(`Watching Claude projects: ${claudeProjectsDir}`);
}

function startCodexWatcher() {
  if (!codexDir) {
    console.log("No Codex sessions directory found");
    return;
  }

  const watcher = watch(codexDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  watcher.on("add", (filePath) => {
    if (
      !path.basename(filePath).startsWith("rollout-") ||
      !filePath.endsWith(".jsonl")
    )
      return;
    const id = codexFileId(filePath);
    filePathMap.set(id, filePath);
    const stats = fs.statSync(filePath);
    setFileOffsetIfUnknown(filePath, stats.size);
    const metadata = buildFileMetadata({
      id,
      filename: path.basename(filePath),
      displayLabel: path.basename(filePath),
      filePath,
      stats,
      source: "codex",
    });
    fileMetaMap.set(id, metadata);
    saveMetadataCache();
    broadcastSSE("file-added", metadata);
  });

  watcher.on("change", (filePath) => {
    if (
      !path.basename(filePath).startsWith("rollout-") ||
      !filePath.endsWith(".jsonl")
    )
      return;
    const id = codexFileId(filePath);
    const update = readNewContent(filePath);
    if (update) {
      const stats = fs.statSync(filePath);
      const metadata = buildFileMetadata({
        id,
        filename: path.basename(filePath),
        displayLabel: path.basename(filePath),
        filePath,
        stats,
        source: "codex",
      });
      fileMetaMap.set(id, metadata);
      saveMetadataCache();
      broadcastSSE("file-update", buildLiveUpdatePayload(metadata, update));
    }
  });

  watcher.on("unlink", (filePath) => {
    if (
      !path.basename(filePath).startsWith("rollout-") ||
      !filePath.endsWith(".jsonl")
    )
      return;
    const id = codexFileId(filePath);
    fileOffsets.delete(filePath);
    filePathMap.delete(id);
    fileMetaMap.delete(id);
    removeMetadataCacheEntry(filePath);
    broadcastSSE("file-removed", { id });
  });

  console.log(`Watching Codex: ${codexDir}`);
}

// SPA fallback: serve index.html for any non-API route (e.g. /:id)
app.get("/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- Start ---

const server = app.listen(PORT, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : PORT;
  console.log(`Agent Viewer running at http://localhost:${port}`);
  getAllFiles();
  startWatcher();
  startClaudeProjectsWatcher();
  startCodexWatcher();
});
