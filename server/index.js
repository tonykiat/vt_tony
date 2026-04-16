import childProcess from "child_process";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import connectPgSimple from "connect-pg-simple";
import cors from "cors";
import express from "express";
import session from "express-session";
import multer from "multer";

import { config } from "./config.js";
import { downloadYouTubeVideo, fetchYouTubeTitle, isYouTubeUrl, normalizeYouTubeUrl, pythonBinForApp } from "./youtube.js";
import { pool } from "./db.js";
import { ensureJobDir, ensureStorageLayout, jobDir, jobPaths, RESULTS_DIR } from "./storage.js";
import { getJobForUser, listEvents, listJobsForUser, loadUser, toUser } from "./videoJobStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistDir = path.join(__dirname, "..", "client", "dist");
const PgSession = connectPgSimple(session);
const app = express();
const upload = multer({ dest: "/tmp/video-dub-app-uploads", limits: { fileSize: config.maxUploadBytes } });
const CHUNK_UPLOAD_DIR = "/tmp/video-dub-app-chunk-uploads";
const CHUNK_SIZE_LIMIT_BYTES = 20 * 1024 * 1024;
const chunkUpload = multer({ dest: CHUNK_UPLOAD_DIR, limits: { fileSize: CHUNK_SIZE_LIMIT_BYTES } });
const appOrigin = new URL(config.appUrl).origin;

ensureStorageLayout();
fs.mkdirSync("/tmp/video-dub-app-uploads", { recursive: true });
fs.mkdirSync(CHUNK_UPLOAD_DIR, { recursive: true });

app.set("trust proxy", 1);
app.use(cors({ origin: appOrigin, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(session({
  store: new PgSession({ pool, tableName: "session", createTableIfMissing: false }),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: true, maxAge: 1000 * 60 * 60 * 24 * 14 },
}));

function authRequired(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Authentication required." });
  next();
}

async function hydrateUser(req, res, next) {
  const user = await loadUser(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: "Session expired." });
  }
  req.user = user;
  next();
}

function approvedRequired(req, res, next) {
  if (req.user.status !== "approved") {
    return res.status(403).json({ error: "Your account is awaiting approval." });
  }
  next();
}

function adminRequired(req, res, next) {
  if (req.user.role !== "admin" || req.user.status !== "approved") {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

function safeUploadId(value) {
  const uploadId = String(value || "");
  return /^[a-zA-Z0-9_-]{16,80}$/.test(uploadId) ? uploadId : "";
}

function safeSourceFilename(value) {
  const filename = path.basename(String(value || "uploaded.mp4"))
    .replace(/[^\w .()[\]-]+/g, "_")
    .slice(0, 180);
  return filename || "uploaded.mp4";
}

function chunkDir(userId, uploadId) {
  return path.join(CHUNK_UPLOAD_DIR, `${userId}-${uploadId}`);
}

function jobOptionsFromBody(body = {}) {
  const voiceMode = ["auto", "male", "female"].includes(body.voiceMode) ? body.voiceMode : config.defaultVoiceMode;
  const subtitleMode = ["both", "en", "th", "none"].includes(body.subtitleMode) ? body.subtitleMode : "both";
  const whisperModel = ["tiny", "base", "small", "medium"].includes(body.whisperModel) ? body.whisperModel : "small";
  return {
    voiceMode,
    subtitleMode,
    whisperModel,
    dubEnabled: String(body.dubEnabled ?? "true") === "true",
    keepOriginalAudio: String(body.keepOriginalAudio || config.keepOriginalAudioDefault) === "true",
  };
}

function spawnWorker(jobId) {
  const pythonBin = path.join(__dirname, "..", ".venv", "bin", "python");
  const workerPath = path.join(__dirname, "..", "worker", "run_next.py");
  const env = { ...process.env, ...config.workerEnvOverrides };
  const subprocess = childProcess.spawn(pythonBin, [workerPath, "--job-id", String(jobId)], {
    detached: true,
    stdio: "ignore",
    cwd: path.join(__dirname, ".."),
    env,
  });
  subprocess.unref();
}

async function createQueuedMp4Job({ req, sourceFilename, sourcePath, uploadMessage }) {
  const options = jobOptionsFromBody(req.body);
  const inserted = await pool.query(
    `INSERT INTO video_jobs (source_filename, source_video_path, status, progress_percent, source_language, target_language, voice_mode, selected_voice, subtitle_mode, dub_enabled, whisper_model, keep_original_audio, provider_bundle, created_by)
     VALUES ($1, $2, 'uploaded', 5, 'en', $3, $4, $5, $6, $7, $8, $9, 'mvp-api', $10)
     RETURNING *`,
    [
      sourceFilename,
      sourcePath,
      config.defaultTargetLanguage,
      options.voiceMode,
      options.voiceMode === "auto" ? "auto-by-detection" : `${options.voiceMode}-preferred`,
      options.subtitleMode,
      options.dubEnabled,
      options.whisperModel,
      options.keepOriginalAudio,
      req.user.id,
    ],
  );

  const job = inserted.rows[0];
  ensureJobDir(job.id);
  const paths = jobPaths(job.id);
  fs.renameSync(sourcePath, paths.sourceVideoPath);
  await pool.query(
    `UPDATE video_jobs SET source_video_path = $1, updated_at = NOW(), status = 'queued', progress_percent = 10 WHERE id = $2`,
    [paths.sourceVideoPath, job.id],
  );
  await pool.query(
    `INSERT INTO video_job_events (job_id, stage, message) VALUES ($1, $2, $3), ($1, $4, $5)`,
    [job.id, "upload", uploadMessage, "queue", "Job queued for English to Thai dubbing."],
  );
  spawnWorker(job.id);
  return getJobForUser(job.id, req.user);
}

async function prepareYouTubeJob(job, paths, youtubeUrl) {
  const rootDir = path.join(__dirname, '..');
  const pythonBin = pythonBinForApp(rootDir);
  const outputTemplate = path.join(paths.root, 'source.%(ext)s');
  try {
    const title = await fetchYouTubeTitle({ pythonBin, workdir: rootDir, youtubeUrl });
    const downloadedPath = await downloadYouTubeVideo({ pythonBin, workdir: rootDir, youtubeUrl, outputTemplate });
    if (downloadedPath !== paths.sourceVideoPath) {
      fs.renameSync(downloadedPath, paths.sourceVideoPath);
    }
    await pool.query(
      `UPDATE video_jobs SET source_filename = $1, source_video_path = $2, updated_at = NOW(), status = 'queued', progress_percent = 10 WHERE id = $3`,
      [`${title}.mp4`, paths.sourceVideoPath, job.id],
    );
    await pool.query(`INSERT INTO video_job_events (job_id, stage, message) VALUES ($1, $2, $3)`, [job.id, 'queue', 'YouTube video downloaded and queued for English to Thai dubbing.']);
    spawnWorker(job.id);
  } catch (error) {
    await pool.query(`UPDATE video_jobs SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`, [error.stderr || error.message || 'Failed to prepare source video.', job.id]);
    await pool.query(`INSERT INTO video_job_events (job_id, stage, message) VALUES ($1, $2, $3)`, [job.id, 'failed', `Source preparation failed: ${error.message}`]);
    console.error(error);
  }
}


app.get("/health", (_req, res) => {
  res.json({ ok: true, app: "video-dub-app", domain: "vt.tonyai.au", defaultVoiceMode: config.defaultVoiceMode });
});

app.get("/api/jobs/upload", (_req, res) => {
  res.json({
    ok: true,
    endpoint: "/api/jobs/upload",
    method: "POST",
    requiresAuth: true,
    contentType: "multipart/form-data",
    fileField: "video",
    supportedUploads: [".mp4", "youtubeUrl"],
    maxUploadMb: config.maxUploadMb,
    note: "Open the dashboard and sign in to create a dubbing job.",
  });
});

app.post("/api/auth/register", async (req, res) => {
  const { email, password, fullName, timezone } = req.body || {};
  if (!email || !password || !fullName) return res.status(400).json({ error: "email, password, and fullName are required." });
  if (String(password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  const existing = await pool.query(`SELECT id FROM users WHERE email = $1`, [email.toLowerCase()]);
  if (existing.rowCount) return res.status(409).json({ error: "Email already registered." });
  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role, status, timezone)
     VALUES ($1, $2, $3, 'member', 'pending', $4)`,
    [email.toLowerCase(), passwordHash, fullName, timezone || config.defaultTimezone],
  );
  res.status(201).json({ ok: true, message: "Registration submitted for approval." });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
  const result = await pool.query(`SELECT * FROM users WHERE email = $1`, [email.toLowerCase()]);
  if (!result.rowCount) return res.status(401).json({ error: "Invalid credentials." });
  const row = result.rows[0];
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials." });
  req.session.userId = row.id;
  res.json({ user: toUser(row) });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", authRequired, hydrateUser, (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/admin/users", authRequired, hydrateUser, adminRequired, async (_req, res) => {
  const result = await pool.query(`SELECT id, email, full_name, role, status, timezone, created_at, updated_at FROM users ORDER BY created_at DESC`);
  res.json({ users: result.rows.map(toUser) });
});

app.patch("/api/admin/users/:id", authRequired, hydrateUser, adminRequired, async (req, res) => {
  const { status, role } = req.body || {};
  const allowedStatus = new Set(["pending", "approved", "denied"]);
  const allowedRole = new Set(["admin", "member"]);
  if (!allowedStatus.has(status) || !allowedRole.has(role)) {
    return res.status(400).json({ error: "Invalid status or role." });
  }
  const result = await pool.query(
    `UPDATE users SET status = $1, role = $2, updated_at = NOW() WHERE id = $3 RETURNING id, email, full_name, role, status, timezone, created_at, updated_at`,
    [status, role, Number(req.params.id)],
  );
  if (!result.rowCount) return res.status(404).json({ error: "User not found." });
  res.json({ user: toUser(result.rows[0]) });
});

app.post("/api/jobs/upload", authRequired, hydrateUser, approvedRequired, upload.single("video"), async (req, res) => {
  const file = req.file;
  const youtubeUrlRaw = String(req.body.youtubeUrl || "").trim();
  const options = jobOptionsFromBody(req.body);

  if (!file && !youtubeUrlRaw) return res.status(400).json({ error: "Upload an MP4 file or provide a YouTube URL." });
  if (file && youtubeUrlRaw) return res.status(400).json({ error: "Choose either an MP4 upload or a YouTube URL, not both." });

  let sourceFilename = file?.originalname || "youtube-video.mp4";
  let sourceInputPath = file?.path || "";
  let youtubeUrl = "";
  if (file) {
    if (!String(file.originalname).toLowerCase().endsWith(".mp4")) {
      fs.unlinkSync(file.path);
      return res.status(400).json({ error: "Only .mp4 uploads are supported." });
    }
  } else {
    if (!isYouTubeUrl(youtubeUrlRaw)) return res.status(400).json({ error: "Only YouTube URLs are supported right now." });
    youtubeUrl = normalizeYouTubeUrl(youtubeUrlRaw);
  }

  const inserted = await pool.query(
    `INSERT INTO video_jobs (source_filename, source_video_path, status, progress_percent, source_language, target_language, voice_mode, selected_voice, subtitle_mode, dub_enabled, whisper_model, keep_original_audio, provider_bundle, created_by)
     VALUES ($1, $2, 'uploaded', 5, 'en', $3, $4, $5, $6, $7, $8, $9, 'mvp-api', $10)
     RETURNING *`,
    [
      sourceFilename,
      sourceInputPath || 'pending-download',
      config.defaultTargetLanguage,
      options.voiceMode,
      options.voiceMode === "auto" ? "auto-by-detection" : `${options.voiceMode}-preferred`,
      options.subtitleMode,
      options.dubEnabled,
      options.whisperModel,
      options.keepOriginalAudio,
      req.user.id,
    ],
  );

  const job = inserted.rows[0];
  ensureJobDir(job.id);
  const paths = jobPaths(job.id);

  try {
    if (file) {
      fs.renameSync(file.path, paths.sourceVideoPath);
      await pool.query(
        `UPDATE video_jobs SET source_video_path = $1, updated_at = NOW(), status = 'queued', progress_percent = 10 WHERE id = $2`,
        [paths.sourceVideoPath, job.id],
      );
      await pool.query(`INSERT INTO video_job_events (job_id, stage, message) VALUES ($1, $2, $3), ($1, $4, $5)`, [job.id, "upload", "MP4 uploaded successfully.", "queue", "Job queued for English to Thai dubbing."]);
      spawnWorker(job.id);
    } else {
      await pool.query(`INSERT INTO video_job_events (job_id, stage, message) VALUES ($1, $2, $3)`, [job.id, 'youtube', `Downloading source video from ${youtubeUrl}`]);
      prepareYouTubeJob(job, paths, youtubeUrl);
    }

    const fresh = await getJobForUser(job.id, req.user);
    res.status(201).json({ job: fresh });
  } catch (error) {
    if (file?.path && fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
    await pool.query(`UPDATE video_jobs SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`, [error.stderr || error.message || 'Failed to prepare source video.', job.id]);
    await pool.query(`INSERT INTO video_job_events (job_id, stage, message) VALUES ($1, $2, $3)`, [job.id, 'failed', `Source preparation failed: ${error.message}`]);
    return res.status(400).json({ error: error.stderr || error.message || 'Failed to prepare source video.' });
  }
});

app.post("/api/jobs/upload/chunk", authRequired, hydrateUser, approvedRequired, chunkUpload.single("chunk"), async (req, res) => {
  const file = req.file;
  const uploadId = safeUploadId(req.body.uploadId);
  const index = Number(req.body.index);
  const total = Number(req.body.total);
  const sourceFilename = safeSourceFilename(req.body.filename);

  if (!file) return res.status(400).json({ error: "Missing upload chunk." });
  if (!uploadId || !Number.isInteger(index) || !Number.isInteger(total) || index < 0 || total < 1 || index >= total || total > 2000) {
    fs.unlinkSync(file.path);
    return res.status(400).json({ error: "Invalid chunk upload metadata." });
  }
  if (!sourceFilename.toLowerCase().endsWith(".mp4")) {
    fs.unlinkSync(file.path);
    return res.status(400).json({ error: "Only .mp4 uploads are supported." });
  }

  const dir = chunkDir(req.user.id, uploadId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ sourceFilename, total, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(file.path, path.join(dir, `part-${String(index).padStart(6, "0")}`));
  res.json({ ok: true, received: index, total });
});

app.post("/api/jobs/upload/complete", authRequired, hydrateUser, approvedRequired, async (req, res) => {
  const uploadId = safeUploadId(req.body.uploadId);
  const total = Number(req.body.total);
  const sourceFilename = safeSourceFilename(req.body.filename);
  if (!uploadId || !Number.isInteger(total) || total < 1 || total > 2000) {
    return res.status(400).json({ error: "Invalid chunk upload metadata." });
  }
  if (!sourceFilename.toLowerCase().endsWith(".mp4")) {
    return res.status(400).json({ error: "Only .mp4 uploads are supported." });
  }

  const dir = chunkDir(req.user.id, uploadId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: "Upload session not found." });

  const assembledPath = path.join(dir, "source.mp4");
  const assembled = fs.createWriteStream(assembledPath);
  try {
    for (let index = 0; index < total; index += 1) {
      const partPath = path.join(dir, `part-${String(index).padStart(6, "0")}`);
      if (!fs.existsSync(partPath)) {
        throw new Error(`Missing upload chunk ${index + 1} of ${total}.`);
      }
      await pipeline(fs.createReadStream(partPath), assembled, { end: false });
    }
    await new Promise((resolve, reject) => {
      assembled.on("finish", resolve);
      assembled.on("error", reject);
      assembled.end();
    });

    const job = await createQueuedMp4Job({
      req,
      sourceFilename,
      sourcePath: assembledPath,
      uploadMessage: "Large MP4 uploaded successfully.",
    });
    fs.rmSync(dir, { recursive: true, force: true });
    res.status(201).json({ job });
  } catch (error) {
    assembled.destroy();
    return res.status(400).json({ error: error.message || "Failed to assemble upload." });
  }
});

app.get("/api/jobs", authRequired, hydrateUser, approvedRequired, async (req, res) => {
  const jobs = await listJobsForUser(req.user);
  res.json({ jobs });
});

app.get("/api/jobs/:id", authRequired, hydrateUser, approvedRequired, async (req, res) => {
  const job = await getJobForUser(Number(req.params.id), req.user);
  if (!job) return res.status(404).json({ error: "Job not found." });
  const events = await listEvents(job.id);
  res.json({ job, events });
});

app.post("/api/jobs/:id/retry", authRequired, hydrateUser, approvedRequired, async (req, res) => {
  const job = await getJobForUser(Number(req.params.id), req.user);
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (job.status !== "failed") return res.status(400).json({ error: "Only failed jobs can be retried." });
  await pool.query(`UPDATE video_jobs SET status = 'queued', progress_percent = 10, error_message = NULL, updated_at = NOW() WHERE id = $1`, [job.id]);
  await pool.query(`INSERT INTO video_job_events (job_id, stage, message) VALUES ($1, $2, $3)`, [job.id, "retry", "Job re-queued by user."]);
  spawnWorker(job.id);
  const fresh = await getJobForUser(job.id, req.user);
  res.json({ job: fresh });
});

app.get("/api/jobs/:id/download", authRequired, hydrateUser, approvedRequired, async (req, res) => {
  const job = await getJobForUser(Number(req.params.id), req.user);
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (!job.outputVideoPath || !fs.existsSync(job.outputVideoPath)) return res.status(404).json({ error: "Output video not ready yet." });
  res.download(job.outputVideoPath, `job-${job.id}.th.mp4`);
});

app.get("/api/jobs/:id/subtitles/:language", authRequired, hydrateUser, approvedRequired, async (req, res) => {
  const job = await getJobForUser(Number(req.params.id), req.user);
  if (!job) return res.status(404).json({ error: "Job not found." });
  const language = String(req.params.language || "").toLowerCase();
  const subtitlePath = language === "en"
    ? path.join(jobDir(job.id), "subtitles.en.srt")
    : language === "th"
      ? path.join(jobDir(job.id), "subtitles.th.srt")
      : "";
  if (!subtitlePath) return res.status(400).json({ error: "Subtitle language must be en or th." });
  if (!fs.existsSync(subtitlePath)) return res.status(404).json({ error: "Subtitle file not ready yet." });
  res.download(subtitlePath, `job-${job.id}.${language}.srt`);
});

app.delete("/api/jobs/:id", authRequired, hydrateUser, approvedRequired, async (req, res) => {
  const job = await getJobForUser(Number(req.params.id), req.user);
  if (!job) return res.status(404).json({ error: "Job not found." });
  await pool.query(`DELETE FROM video_jobs WHERE id = $1`, [job.id]);
  fs.rmSync(jobDir(job.id), { recursive: true, force: true });
  res.json({ ok: true });
});

if (fs.existsSync(clientDistDir)) {
  app.use(express.static(clientDistDir));
  app.get(/^\/(?!api|health).*/, (_req, res) => {
    res.sendFile(path.join(clientDistDir, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res.type("text/plain").send("video-dub-app server is running; build the client to serve the dashboard UI.");
  });
}

app.use((error, _req, res, _next) => {
  if (error?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `Upload exceeds ${config.maxUploadMb} MB limit.` });
  }
  console.error(error);
  res.status(500).json({ error: "Internal server error." });
});

app.listen(config.port, "127.0.0.1", () => {
  console.log(`video-dub-app listening on 127.0.0.1:${config.port}`);
});
