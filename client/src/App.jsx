import { useEffect, useRef, useState } from "react";

const API = "";
const CHUNKED_UPLOAD_THRESHOLD_BYTES = 90 * 1024 * 1024;
const CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
const card = {
  background: "rgba(15, 23, 42, 0.8)",
  border: "1px solid rgba(148, 163, 184, 0.25)",
  borderRadius: 20,
  padding: 20,
  boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
};
const input = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: 12,
  border: "1px solid #334155",
  background: "#0f172a",
  color: "#e2e8f0",
};
const button = {
  padding: "12px 16px",
  borderRadius: 12,
  border: 0,
  background: "#38bdf8",
  color: "#082f49",
  fontWeight: 700,
  cursor: "pointer",
};
const progressOuter = {
  width: "100%",
  height: 12,
  borderRadius: 999,
  overflow: "hidden",
  background: "#1e293b",
  border: "1px solid #334155",
};

function ProgressBar({ value, animated = false, label }) {
  const safe = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {label ? <div style={{ fontSize: 13, color: "#93c5fd" }}>{label}</div> : null}
      <div style={progressOuter}>
        <div
          style={{
            width: `${safe}%`,
            height: "100%",
            background: animated
              ? "linear-gradient(90deg, #38bdf8, #22c55e, #38bdf8)"
              : "linear-gradient(90deg, #38bdf8, #22c55e)",
            backgroundSize: animated ? "200% 100%" : undefined,
            animation: animated ? "shimmer 1.6s linear infinite" : undefined,
            transition: "width 0.4s ease",
          }}
        />
      </div>
      <div style={{ fontSize: 12, color: "#94a3b8" }}>{safe.toFixed(0)}%</div>
    </div>
  );
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    credentials: "include",
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || "Request failed" };
  }
  if (!response.ok) throw new Error(data.error || `Request failed with HTTP ${response.status}`);
  return data;
}

function formatBytes(bytes) {
  if (!bytes) return "0 MB";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(seconds) {
  if (seconds == null) return "estimating";
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(safe / 60);
  const secs = safe % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    return `${hours}h ${remMinutes}m`;
  }
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function AuthForm({ onAuthed }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ email: "", password: "", fullName: "", timezone: "Australia/Sydney" });
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setError("");
    try {
      if (mode === "login") {
        const data = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: form.email, password: form.password }) });
        onAuthed(data.user);
      } else {
        await api("/api/auth/register", { method: "POST", body: JSON.stringify(form) });
        setMode("login");
      }
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div style={{ display: "grid", gap: 24, gridTemplateColumns: "1.3fr 1fr", alignItems: "start" }}>
      <section style={card}>
        <div style={{ display: "inline-block", padding: "6px 12px", borderRadius: 999, background: "#0c4a6e", color: "#bae6fd", fontSize: 13, marginBottom: 12 }}>
          vt.tonyai.au
        </div>
        <h1 style={{ fontSize: 46, lineHeight: 1.1, margin: "0 0 12px" }}>English to Thai video dubbing</h1>
        <p style={{ color: "#94a3b8", fontSize: 18, lineHeight: 1.6 }}>
          Upload an English MP4, automatically detect whether the speaker sounds male or female, translate the speech to Thai, and return a dubbed Thai MP4.
        </p>
        <ul style={{ color: "#cbd5e1", lineHeight: 1.8 }}>
          <li>Voice mode defaults to auto detection</li>
          <li>Future worker can override with detected male/female speaker gender</li>
          <li>Admin approval flow matches your existing dashboard pattern</li>
        </ul>
      </section>
      <form style={{ ...card, display: "grid", gap: 12 }} onSubmit={submit}>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" style={{ ...button, opacity: mode === "login" ? 1 : 0.65 }} onClick={() => setMode("login")}>Login</button>
          <button type="button" style={{ ...button, opacity: mode === "register" ? 1 : 0.65 }} onClick={() => setMode("register")}>Register</button>
        </div>
        {mode === "register" && <input style={input} placeholder="Full name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />}
        <input style={input} placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input style={input} placeholder="Password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        {mode === "register" && <input style={input} placeholder="Timezone" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />}
        {error ? <div style={{ color: "#fecaca", background: "#7f1d1d", padding: 12, borderRadius: 12 }}>{error}</div> : null}
        <button style={button}>{mode === "login" ? "Sign in" : "Request access"}</button>
      </form>
    </div>
  );
}

function Dashboard({ user, onLogout }) {
  const fileInputRef = useRef(null);
  const [jobs, setJobs] = useState([]);
  const [worker, setWorker] = useState(null);
  const [users, setUsers] = useState([]);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadLabel, setUploadLabel] = useState("");
  const [file, setFile] = useState(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [voiceMode, setVoiceMode] = useState("auto");
  const [subtitleMode, setSubtitleMode] = useState("both");
  const [dubEnabled, setDubEnabled] = useState(true);
  const [whisperModel, setWhisperModel] = useState("small");
  const [keepOriginalAudio, setKeepOriginalAudio] = useState(false);

  async function loadJobs() {
    try {
      const data = await api("/api/jobs");
      setJobs(data.jobs || []);
      setWorker(data.worker || null);
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadUsers() {
    if (user.role !== "admin") return;
    const data = await api("/api/admin/users");
    setUsers(data.users || []);
  }

  useEffect(() => {
    loadJobs();
    loadUsers();
    const timer = setInterval(loadJobs, 10000);
    return () => clearInterval(timer);
  }, []);

  async function uploadJob(e) {
    e.preventDefault();
    if (!file && !youtubeUrl.trim()) {
      setError("Choose an MP4 file or enter a YouTube URL first.");
      return;
    }
    setUploading(true);
    setUploadProgress(0);
    setError("");
    try {
      if (file && file.size > CHUNKED_UPLOAD_THRESHOLD_BYTES) {
        await uploadLargeFile(file);
      } else {
        setUploadProgress(30);
        setUploadLabel(youtubeUrl.trim() ? "Fetching source video from YouTube and queueing job..." : "Uploading MP4 and queueing job...");
        const form = new FormData();
        if (file) form.append("video", file);
        if (youtubeUrl.trim()) form.append("youtubeUrl", youtubeUrl.trim());
        form.append("voiceMode", voiceMode);
        form.append("subtitleMode", subtitleMode);
        form.append("dubEnabled", String(dubEnabled));
        form.append("whisperModel", whisperModel);
        form.append("keepOriginalAudio", String(keepOriginalAudio));
        await api("/api/jobs/upload", { method: "POST", body: form });
      }
      setFile(null);
      setYoutubeUrl("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      await loadJobs();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      setUploadProgress(0);
      setUploadLabel("");
    }
  }

  async function uploadLargeFile(selectedFile) {
    const uploadId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const total = Math.ceil(selectedFile.size / CHUNK_SIZE_BYTES);

    for (let index = 0; index < total; index += 1) {
      const start = index * CHUNK_SIZE_BYTES;
      const chunk = selectedFile.slice(start, Math.min(start + CHUNK_SIZE_BYTES, selectedFile.size));
      const form = new FormData();
      form.append("uploadId", uploadId);
      form.append("index", String(index));
      form.append("total", String(total));
      form.append("filename", selectedFile.name);
      form.append("chunk", chunk, selectedFile.name);
      setUploadProgress(Math.max(1, Math.round((index / total) * 90)));
      setUploadLabel(`Uploading ${formatBytes(selectedFile.size)} MP4: chunk ${index + 1} of ${total}`);
      await api("/api/jobs/upload/chunk", { method: "POST", body: form });
    }

    setUploadProgress(95);
    setUploadLabel("Assembling MP4 and queueing job...");
    await api("/api/jobs/upload/complete", {
      method: "POST",
      body: JSON.stringify({
        uploadId,
        total,
        filename: selectedFile.name,
        voiceMode,
        subtitleMode,
        dubEnabled: String(dubEnabled),
        whisperModel,
        keepOriginalAudio: String(keepOriginalAudio),
      }),
    });
  }

  async function approveUser(id, role, status) {
    await api(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify({ role, status }) });
    await loadUsers();
  }

  async function deleteJob(id) {
    const ok = window.confirm("Delete this job and its generated files?");
    if (!ok) return;
    setError("");
    try {
      await api(`/api/jobs/${id}`, { method: "DELETE" });
      await loadJobs();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div style={{ display: "grid", gap: 24 }}>
      <section style={{ ...card, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ color: "#7dd3fc", fontSize: 13, textTransform: "uppercase", letterSpacing: 2 }}>VT TonyAI</div>
          <h2 style={{ margin: "8px 0 4px", fontSize: 32 }}>Welcome, {user.fullName}</h2>
          <div style={{ color: "#94a3b8" }}>{user.email} · {user.role} · {user.status}</div>
          {worker ? <div style={{ color: "#cbd5e1", fontSize: 14, marginTop: 6 }}>Workers: {worker.active}/{worker.maxParallel} running</div> : null}
        </div>
        <button style={button} onClick={onLogout}>Log out</button>
      </section>

      <section style={card}>
        <h3 style={{ marginTop: 0 }}>Create dubbing job</h3>
        {uploading ? (
          <div style={{ marginBottom: 16, padding: 14, borderRadius: 14, background: "rgba(8, 145, 178, 0.12)", border: "1px solid rgba(56, 189, 248, 0.35)" }}>
            <ProgressBar value={uploadProgress || 30} animated label={uploadLabel || "Preparing upload..."} />
          </div>
        ) : null}
        <form onSubmit={uploadJob} style={{ display: "grid", gap: 12 }}>
          <div>
            <div style={{ marginBottom: 8 }}>Upload MP4</div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button type="button" style={button} onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                Choose MP4
              </button>
              <span style={{ color: file ? "#cbd5e1" : "#94a3b8", fontSize: 14 }}>
                {file ? `${file.name} (${formatBytes(file.size)}${file.size > CHUNKED_UPLOAD_THRESHOLD_BYTES ? ", large upload" : ""})` : "No file selected"}
              </span>
              {file ? (
                <button
                  type="button"
                  style={{ ...button, background: "#334155", color: "#e2e8f0" }}
                  onClick={() => {
                    setFile(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                  disabled={uploading}
                >
                  Clear
                </button>
              ) : null}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/mp4,.mp4"
              style={{ display: "none" }}
              onChange={(e) => {
                const selected = e.target.files?.[0] || null;
                setFile(selected);
                if (selected) setYoutubeUrl("");
                setError("");
              }}
            />
          </div>
          <div style={{ color: "#94a3b8", fontSize: 14, textAlign: "center" }}>or</div>
          <label>
            YouTube URL
            <input
              style={{ ...input, marginTop: 6 }}
              placeholder="https://www.youtube.com/watch?v=..."
              value={youtubeUrl}
              onChange={(e) => {
                setYoutubeUrl(e.target.value);
                if (e.target.value.trim()) {
                  setFile(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }
                setError("");
              }}
            />
          </label>
          <label>
            Transcription model
            <select style={{ ...input, marginTop: 6 }} value={whisperModel} onChange={(e) => setWhisperModel(e.target.value)}>
              <option value="small">Small - better quality, recommended</option>
              <option value="base">Base - faster</option>
              <option value="tiny">Tiny - fastest</option>
              <option value="medium">Medium - best quality, slow CPU</option>
            </select>
          </label>
          <label>
            Subtitles
            <select style={{ ...input, marginTop: 6 }} value={subtitleMode} onChange={(e) => setSubtitleMode(e.target.value)}>
              <option value="both">English and Thai</option>
              <option value="en">English only</option>
              <option value="th">Thai only</option>
              <option value="none">No subtitles</option>
            </select>
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={dubEnabled} onChange={(e) => setDubEnabled(e.target.checked)} />
            Generate Thai dubbed audio
          </label>
          <label>
            Thai voice
            <select style={{ ...input, marginTop: 6 }} value={voiceMode} onChange={(e) => setVoiceMode(e.target.value)} disabled={!dubEnabled}>
              <option value="auto">Auto detect speaker gender</option>
              <option value="male">Force male Thai voice</option>
              <option value="female">Force female Thai voice</option>
            </select>
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={keepOriginalAudio} onChange={(e) => setKeepOriginalAudio(e.target.checked)} disabled={!dubEnabled} />
            Keep original audio quietly underneath Thai dub
          </label>
          <button style={button} disabled={uploading || (!file && !youtubeUrl.trim())}>{uploading ? "Submitting..." : "Create dubbing job"}</button>
        </form>
        {error ? <div style={{ color: "#fecaca", marginTop: 12 }}>{error}</div> : null}
      </section>

      <section style={card}>
        <h3 style={{ marginTop: 0 }}>Recent jobs</h3>
        <div style={{ display: "grid", gap: 12 }}>
          {jobs.length === 0 ? <div style={{ color: "#94a3b8" }}>No jobs yet.</div> : jobs.map((job) => (
            <div key={job.id} style={{ border: "1px solid #334155", borderRadius: 16, padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{job.sourceFilename}</div>
                  <div style={{ color: "#94a3b8", fontSize: 14 }}>Job #{job.id} · {job.status} · {job.progressPercent}%</div>
                  <div style={{ color: "#cbd5e1", fontSize: 14 }}>
                    Dub: {job.dubEnabled ? job.voiceMode : "off"} · subtitles: {job.subtitleMode || "both"} · model: {job.whisperModel || "small"} · detected: {job.speakerGenderDetected || "pending"}
                  </div>
                  <div style={{ color: "#94a3b8", fontSize: 14 }}>
                    {job.status === "done" ? "Finished" : job.status === "failed" ? "Stopped" : `ETA: about ${formatDuration(job.estimatedRemainingSeconds)} left`}
                    {job.durationSeconds ? ` · video: ${formatDuration(job.durationSeconds)}` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                  {job.status === "done" && job.outputVideoPath ? (
                    <>
                      <a href={`/api/jobs/${job.id}/download`} style={{ color: "#7dd3fc" }}>MP4</a>
                      {["both", "en"].includes(job.subtitleMode || "both") ? <a href={`/api/jobs/${job.id}/subtitles/en`} style={{ color: "#7dd3fc" }}>EN SRT</a> : null}
                      {["both", "th"].includes(job.subtitleMode || "both") ? <a href={`/api/jobs/${job.id}/subtitles/th`} style={{ color: "#7dd3fc" }}>TH SRT</a> : null}
                    </>
                  ) : null}
                  <button
                    type="button"
                    style={{ ...button, background: "#334155", color: "#e2e8f0", padding: "8px 10px" }}
                    onClick={() => deleteJob(job.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div style={{ marginTop: 14 }}>
                <ProgressBar
                  value={job.progressPercent}
                  animated={job.status !== "done" && job.status !== "failed"}
                  label={job.status === "done" ? "Completed" : job.status === "failed" ? `Failed${job.errorMessage ? `: ${job.errorMessage}` : ""}` : `Working: ${job.status}`}
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      {user.role === "admin" ? (
        <section style={card}>
          <h3 style={{ marginTop: 0 }}>Admin approvals</h3>
          <div style={{ display: "grid", gap: 10 }}>
            {users.map((entry) => (
              <div key={entry.id} style={{ border: "1px solid #334155", borderRadius: 14, padding: 14, display: "flex", justifyContent: "space-between", gap: 16 }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{entry.fullName}</div>
                  <div style={{ color: "#94a3b8" }}>{entry.email}</div>
                  <div style={{ color: "#cbd5e1", fontSize: 14 }}>{entry.role} · {entry.status}</div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={button} onClick={() => approveUser(entry.id, entry.role, "approved")}>Approve</button>
                  <button style={{ ...button, background: "#f87171", color: "#450a0a" }} onClick={() => approveUser(entry.id, entry.role, "denied")}>Deny</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api("/api/me").then((data) => setUser(data.user)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    setUser(null);
  }

  return (
    <main style={{ maxWidth: 1200, margin: "0 auto", padding: 24, display: "grid", gap: 24 }}>
      <style>{`@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      {loading ? <div>Loading…</div> : user ? <Dashboard user={user} onLogout={logout} /> : <AuthForm onAuthed={setUser} />}
    </main>
  );
}
