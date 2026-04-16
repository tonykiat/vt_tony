import bcrypt from "bcryptjs";
import { config } from "./config.js";
import { pool, withClient } from "./db.js";
import { ensureStorageLayout } from "./storage.js";

async function main() {
  ensureStorageLayout();
  await withClient(async (client) => {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
        timezone TEXT NOT NULL DEFAULT 'Australia/Sydney',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS session (
        sid VARCHAR NOT NULL PRIMARY KEY,
        sess JSON NOT NULL,
        expire TIMESTAMPTZ NOT NULL
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS session_expire_idx ON session(expire)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS video_jobs (
        id SERIAL PRIMARY KEY,
        source_filename TEXT NOT NULL,
        source_video_path TEXT NOT NULL,
        source_audio_path TEXT,
        transcript_json_path TEXT,
        translated_json_path TEXT,
        thai_audio_path TEXT,
        output_video_path TEXT,
        status TEXT NOT NULL CHECK (status IN ('uploaded','queued','extracting_audio','transcribing','translating','generating_voice','muxing','done','failed')),
        progress_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
        source_language TEXT NOT NULL DEFAULT 'en',
        target_language TEXT NOT NULL DEFAULT 'th',
        voice_mode TEXT NOT NULL DEFAULT 'auto' CHECK (voice_mode IN ('auto','male','female')),
        selected_voice TEXT NOT NULL DEFAULT 'auto',
        subtitle_mode TEXT NOT NULL DEFAULT 'both' CHECK (subtitle_mode IN ('both','en','th','none')),
        dub_enabled BOOLEAN NOT NULL DEFAULT true,
        whisper_model TEXT NOT NULL DEFAULT 'small' CHECK (whisper_model IN ('tiny','base','small','medium')),
        speaker_gender_detected TEXT CHECK (speaker_gender_detected IN ('male','female') OR speaker_gender_detected IS NULL),
        keep_original_audio BOOLEAN NOT NULL DEFAULT false,
        provider_bundle TEXT NOT NULL DEFAULT 'mvp-api',
        duration_seconds NUMERIC(10,2),
        error_message TEXT,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS subtitle_mode TEXT NOT NULL DEFAULT 'both' CHECK (subtitle_mode IN ('both','en','th','none'))`);
    await client.query(`ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS dub_enabled BOOLEAN NOT NULL DEFAULT true`);
    await client.query(`ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS whisper_model TEXT NOT NULL DEFAULT 'small' CHECK (whisper_model IN ('tiny','base','small','medium'))`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS video_job_events (
        id SERIAL PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES video_jobs(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const existingAdmin = await client.query(`SELECT id FROM users WHERE email = $1`, [config.seedAdminEmail]);
    if (existingAdmin.rowCount === 0) {
      const passwordHash = await bcrypt.hash(config.seedAdminPassword, 10);
      await client.query(
        `INSERT INTO users (email, password_hash, full_name, role, status, timezone)
         VALUES ($1, $2, $3, 'admin', 'approved', $4)`,
        [config.seedAdminEmail, passwordHash, config.seedAdminName, config.defaultTimezone],
      );
    }

    await client.query("COMMIT");
  });

  console.log("Database initialized.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
