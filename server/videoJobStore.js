import { pool } from "./db.js";

const MODEL_SPEED_FACTOR = {
  tiny: 0.8,
  base: 1.2,
  small: 2.8,
  medium: 8.0,
};
const STAGE_PROGRESS_FLOOR = {
  uploaded: 0,
  queued: 0,
  extracting_audio: 0.08,
  transcribing: 0.12,
  translating: 0.7,
  generating_voice: 0.82,
  muxing: 0.94,
  done: 1,
  failed: 0,
};

function estimateTotalSeconds(row) {
  const duration = Number(row.duration_seconds || 0);
  if (!duration) return null;
  const modelFactor = MODEL_SPEED_FACTOR[row.whisper_model] || MODEL_SPEED_FACTOR.small;
  const ttsFactor = row.tts_provider === "elevenlabs" ? 1.1 : 0.8;
  const dubFactor = row.dub_enabled ? ttsFactor : 0.15;
  const thaiFactor = row.subtitle_mode === "th" || row.subtitle_mode === "both" || row.dub_enabled ? 0.35 : 0;
  return Math.max(30, Math.round(duration * (modelFactor + dubFactor + thaiFactor + 0.2)));
}

function estimateRemainingSeconds(row) {
  if (row.status === "done" || row.status === "failed") return 0;
  const total = estimateTotalSeconds(row);
  if (!total) return null;
  const floor = STAGE_PROGRESS_FLOOR[row.status] ?? 0;
  const progress = Math.max(floor, Math.min(0.98, Number(row.progress_percent || 0) / 100));
  const remaining = Math.max(0, Math.round(total * (1 - progress)));
  return remaining;
}

export function toUser(row) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    status: row.status,
    timezone: row.timezone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toJob(row) {
  return {
    id: row.id,
    sourceFilename: row.source_filename,
    sourceVideoPath: row.source_video_path,
    sourceAudioPath: row.source_audio_path,
    transcriptJsonPath: row.transcript_json_path,
    translatedJsonPath: row.translated_json_path,
    thaiAudioPath: row.thai_audio_path,
    outputVideoPath: row.output_video_path,
    status: row.status,
    progressPercent: Number(row.progress_percent || 0),
    sourceLanguage: row.source_language,
    targetLanguage: row.target_language,
    voiceMode: row.voice_mode,
    selectedVoice: row.selected_voice,
    subtitleMode: row.subtitle_mode,
    dubEnabled: row.dub_enabled,
    ttsProvider: row.tts_provider,
    whisperModel: row.whisper_model,
    speakerGenderDetected: row.speaker_gender_detected,
    keepOriginalAudio: row.keep_original_audio,
    providerBundle: row.provider_bundle,
    durationSeconds: row.duration_seconds,
    estimatedTotalSeconds: estimateTotalSeconds(row),
    estimatedRemainingSeconds: estimateRemainingSeconds(row),
    errorMessage: row.error_message,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function loadUser(userId) {
  const result = await pool.query(
    `SELECT id, email, full_name, role, status, timezone, created_at, updated_at FROM users WHERE id = $1`,
    [userId],
  );
  return result.rowCount ? toUser(result.rows[0]) : null;
}

export async function listJobsForUser(user) {
  const sql = user.role === "admin"
    ? `SELECT * FROM video_jobs ORDER BY created_at DESC LIMIT 100`
    : `SELECT * FROM video_jobs WHERE created_by = $1 ORDER BY created_at DESC LIMIT 100`;
  const params = user.role === "admin" ? [] : [user.id];
  const result = await pool.query(sql, params);
  return result.rows.map(toJob);
}

export async function getJobForUser(jobId, user) {
  const sql = user.role === "admin"
    ? `SELECT * FROM video_jobs WHERE id = $1`
    : `SELECT * FROM video_jobs WHERE id = $1 AND created_by = $2`;
  const params = user.role === "admin" ? [jobId] : [jobId, user.id];
  const result = await pool.query(sql, params);
  return result.rowCount ? toJob(result.rows[0]) : null;
}

export async function listEvents(jobId) {
  const result = await pool.query(
    `SELECT id, job_id, stage, message, created_at FROM video_job_events WHERE job_id = $1 ORDER BY created_at ASC, id ASC`,
    [jobId],
  );
  return result.rows;
}
