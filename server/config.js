import dotenv from "dotenv";

dotenv.config();

const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 500);

export const config = {
  port: Number(process.env.PORT || 4310),
  appUrl: process.env.APP_URL || "https://vt.tonyai.au",
  appBasePath: process.env.APP_BASE_PATH || "/",
  sessionSecret: process.env.SESSION_SECRET || "change-me",
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://video_dub_app:***@127.0.0.1:5432/video_dub_dashboard",
  defaultTimezone: process.env.DEFAULT_TIMEZONE || "Australia/Sydney",
  seedAdminEmail: process.env.SEED_ADMIN_EMAIL || "admin@tonyai.au",
  seedAdminName: process.env.SEED_ADMIN_NAME || "Tony Admin",
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!",
  videoStorageRoot: process.env.VIDEO_STORAGE_ROOT || "/home/paperclip/video_dubber",
  maxUploadBytes: maxUploadMb * 1024 * 1024,
  maxUploadMb,
  defaultVoiceMode: process.env.DEFAULT_VOICE_MODE || "auto",
  defaultTargetLanguage: process.env.DEFAULT_TARGET_LANGUAGE || "th",
  keepOriginalAudioDefault: String(process.env.KEEP_ORIGINAL_AUDIO_DEFAULT || "false") === "true",
  workerEnvOverrides: {
    DATABASE_URL: process.env.DATABASE_URL,
    DEFAULT_THAI_VOICE_MALE: process.env.DEFAULT_THAI_VOICE_MALE || "th-TH-NiwatNeural",
    DEFAULT_THAI_VOICE_FEMALE: process.env.DEFAULT_THAI_VOICE_FEMALE || "th-TH-PremwadeeNeural",
    WHISPER_MODEL: process.env.WHISPER_MODEL || "small",
  },
};
