import { pool } from "./db.js";

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
    whisperModel: row.whisper_model,
    speakerGenderDetected: row.speaker_gender_detected,
    keepOriginalAudio: row.keep_original_audio,
    providerBundle: row.provider_bundle,
    durationSeconds: row.duration_seconds,
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
