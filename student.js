(() => {
  "use strict";

  const CONFIG_PATH = "./config/supabase.json";
  const ENDPOINT_PATH = "/functions/v1/participant-access";
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const FOCUS_LOSS_DEBOUNCE_MS = 10_000;
  const ALARM_POLL_INTERVAL_MS = 2_500;

  const elements = {
    loginScreen: document.getElementById("login-screen"),
    loginForm: document.getElementById("login-form"),
    loginError: document.getElementById("login-error"),
    loginButton: document.getElementById("login-button"),
    localFileWarning: document.getElementById("local-file-warning"),
    nis: document.getElementById("student-nis"),
    lessonToken: document.getElementById("lesson-token"),
    examScreen: document.getElementById("exam-screen"),
    participantName: document.getElementById("participant-name"),
    participantRoom: document.getElementById("participant-room"),
    lessonTitle: document.getElementById("lesson-title"),
    connectionIndicator: document.getElementById("connection-indicator"),
    participantAlert: document.getElementById("participant-alert"),
    examFormFrame: document.getElementById("exam-form-frame"),
    formFallback: document.getElementById("form-fallback"),
    openFormLink: document.getElementById("open-form-link"),
    examStopPanel: document.getElementById("exam-stop-panel"),
    examStopMessage: document.getElementById("exam-stop-message"),
    requestExit: document.getElementById("request-exit"),
    exitDialog: document.getElementById("exit-dialog"),
    exitForm: document.getElementById("exit-form"),
    roomToken: document.getElementById("room-token"),
    exitError: document.getElementById("exit-error"),
    exitCancel: document.getElementById("exit-cancel"),
    exitSubmit: document.getElementById("exit-submit"),
  };

  const state = {
    config: null,
    exam: null,
    heartbeatTimer: null,
    alarmPollTimer: null,
    fallbackTimer: null,
    lastFocusLossAt: 0,
  };

  function looksLikeServiceRoleKey(key) {
    const parts = key.split(".");
    if (parts.length !== 3) return false;
    try {
      let encodedPayload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      encodedPayload += "=".repeat((4 - encodedPayload.length % 4) % 4);
      const payload = JSON.parse(atob(encodedPayload));
      return payload.role === "service_role";
    } catch {
      return false;
    }
  }

  function validateConfig(config) {
    let url;
    try {
      url = new URL(config.url);
    } catch {
      throw new Error("URL di config/supabase.json tidak valid.");
    }

    if (url.protocol !== "https:" || !url.hostname || url.hostname.includes("your_project_id") ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash
    ) {
      throw new Error("URL di config/supabase.json harus berupa URL dasar HTTPS.");
    }
    const key = typeof config.anonKey === "string" ? config.anonKey.trim() : "";
    if (!key || key.includes("YOUR_SUPABASE")) {
      throw new Error("Isi anonKey pada config/supabase.json sebelum menjalankan portal.");
    }
    if (looksLikeServiceRoleKey(key)) {
      throw new Error("config/supabase.json berisi service_role. Gunakan anon/public key.");
    }
    return { url: url.toString().replace(/\/+$/, ""), key };
  }

  async function loadConfig() {
    if (location.protocol === "file:") {
      throw new Error("Buka portal melalui HTTP/HTTPS; file:// tidak dapat memuat konfigurasi bersama.");
    }

    let response;
    try {
      response = await fetch(CONFIG_PATH, { cache: "no-store" });
    } catch {
      throw new Error("Tidak dapat memuat config/supabase.json. Pastikan file ikut di-deploy dan gunakan HTTP/HTTPS.");
    }
    if (!response.ok) {
      throw new Error(`Gagal memuat config/supabase.json (HTTP ${response.status}).`);
    }

    let config;
    try {
      config = await response.json();
    } catch {
      throw new Error("config/supabase.json bukan JSON yang valid.");
    }
    return validateConfig(config);
  }

  function setMessage(element, message) {
    element.textContent = message || "";
  }

  function setBusy(button, busy, busyText, idleText) {
    button.disabled = busy;
    button.textContent = busy ? busyText : idleText;
  }

  function setConnectionStatus(connected, message) {
    elements.connectionIndicator.textContent = message || (connected ? "Terhubung" : "Koneksi terputus");
    elements.connectionIndicator.classList.toggle("offline", !connected);
  }

  function notifyNativeHost(examActive) {
    const bridge = window.chrome && window.chrome.webview;
    if (bridge) bridge.postMessage({ type: "exam-state", active: examActive });
  }

  function notifyNativeHostOfAlarm(active) {
    const bridge = window.chrome && window.chrome.webview;
    if (bridge) bridge.postMessage({ type: "alarm-state", active });
  }

  async function callEndpoint(payload, options = {}) {
    if (!state.config) throw new Error("Koneksi Supabase belum diatur.");

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${state.config.url}${ENDPOINT_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: state.config.key,
          Authorization: `Bearer ${state.config.key}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        keepalive: Boolean(options.keepalive),
      });

      const result = await response.json().catch(() => null);
      if (!response.ok) {
        const message = result && typeof result.error === "string"
          ? result.error
          : `Permintaan gagal (HTTP ${response.status}).`;
        const error = new Error(message);
        error.status = response.status;
        throw error;
      }
      if (!result || typeof result !== "object") {
        throw new Error("Respons server tidak valid. Coba lagi atau hubungi admin.");
      }
      return result;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("Koneksi terlalu lama. Periksa jaringan lalu coba lagi.");
      }
      if (error instanceof TypeError) {
        const message = location.protocol === "file:"
          ? "Gagal menghubungi Supabase. Portal dibuka sebagai file lokal; jalankan lewat server HTTP atau gunakan situs GitHub Pages."
          : "Gagal menghubungi Supabase. Periksa Project URL, koneksi internet, deployment Edge Function participant-access, dan konfigurasi CORS.";
        throw new Error(message);
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function validateFormUrl(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Tautan formulir ujian tidak valid. Hubungi admin.");
    }
    if (url.protocol !== "https:" || url.hostname !== "docs.google.com" || !url.pathname.startsWith("/forms/")) {
      throw new Error("Tautan ujian bukan Google Forms yang valid. Hubungi admin.");
    }
    url.searchParams.set("embedded", "true");
    return url.toString();
  }

  function startExam(result, nis, participantToken) {
    if (!result.session || !result.participant || !result.session.id) {
      throw new Error("Data ujian dari server tidak lengkap. Hubungi admin.");
    }

    const formUrl = validateFormUrl(result.session.gform_url);
    const participant = result.participant;
    const roomName = participant.room_name
      ? participant.room_name
      : "Ruang belum tersedia";
    const seat = participant.seat_number ? ` · Kursi ${participant.seat_number}` : "";

    state.exam = {
      nis,
      participantToken,
      sessionId: result.session.id,
      stopped: false,
      blocked: false,
    };
    notifyNativeHost(true);

    elements.participantName.textContent = participant.name || nis;
    elements.participantRoom.textContent = `${roomName}${seat}`;
    elements.lessonTitle.textContent = result.session.title || "Ujian";
    setMessage(elements.participantAlert, "");
    setConnectionStatus(true);
    elements.loginScreen.classList.add("hidden");
    elements.examScreen.classList.remove("hidden");
    elements.openFormLink.href = formUrl;
    elements.formFallback.classList.add("hidden");
    elements.examStopPanel.classList.add("hidden");
    elements.examFormFrame.classList.remove("hidden");
    elements.examFormFrame.addEventListener("load", () => {
      if (state.fallbackTimer) window.clearTimeout(state.fallbackTimer);
      state.fallbackTimer = null;
    }, { once: true });
    state.fallbackTimer = window.setTimeout(() => {
      elements.formFallback.classList.remove("hidden");
    }, 8_000);
    elements.examFormFrame.src = formUrl;

    state.heartbeatTimer = window.setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  }

  async function sendHeartbeat() {
    if (!state.exam || state.exam.stopped) return;
    const exam = state.exam;
    try {
      await callEndpoint({
        action: "heartbeat",
        nis: exam.nis,
        session_id: exam.sessionId,
        participant_token: exam.participantToken,
      });
      if (state.exam !== exam) return;
      setConnectionStatus(true);
    } catch (error) {
      if (state.exam !== exam) return;
      if (error.status === 403 || error.status === 423) {
        const bridge = window.chrome && window.chrome.webview;
        if (error.status === 423 && bridge) {
          blockNativeExam({});
          return;
        }
        stopExam(error.message);
        return;
      }
      setConnectionStatus(false);
      console.warn("Heartbeat peserta gagal.", error);
    }
  }

  function stopExam(message) {
    if (state.heartbeatTimer) window.clearInterval(state.heartbeatTimer);
    if (state.alarmPollTimer) window.clearTimeout(state.alarmPollTimer);
    state.heartbeatTimer = null;
    state.alarmPollTimer = null;
    state.exam.stopped = true;
    elements.examFormFrame.removeAttribute("src");
    elements.examFormFrame.classList.add("hidden");
    elements.formFallback.classList.add("hidden");
    elements.examStopPanel.classList.remove("native-lock-panel");
    elements.examStopMessage.textContent = message;
    elements.examStopPanel.classList.remove("hidden");
    setConnectionStatus(false, "Akses dihentikan");
    const bridge = window.chrome && window.chrome.webview;
    if (bridge) bridge.postMessage({ type: "exam-stopped" });
  }

  function blockNativeExam(result) {
    if (!state.exam) return;
    state.exam.stopped = true;
    state.exam.blocked = true;
    if (state.heartbeatTimer) window.clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
    elements.examStopMessage.textContent = "Pelanggaran tercatat. Minta pengawas memasukkan kode untuk melanjutkan.";
    elements.examStopPanel.classList.add("native-lock-panel");
    elements.examStopPanel.classList.remove("hidden");
    setConnectionStatus(false, "Ujian dijeda");
    const bridge = window.chrome && window.chrome.webview;
    if (bridge) {
      bridge.postMessage({
        type: "violation",
        violationCount: Number(result.violation_count) || 0,
      });
    }
    notifyNativeHostOfAlarm(true);
    pollNativeAlarmStatus();
  }

  function resumeNativeExam() {
    if (!state.exam || !state.exam.blocked) return;
    if (state.alarmPollTimer) window.clearTimeout(state.alarmPollTimer);
    state.alarmPollTimer = null;
    state.exam.blocked = false;
    state.exam.stopped = false;
    elements.examStopPanel.classList.add("hidden");
    elements.examStopPanel.classList.remove("native-lock-panel");
    elements.examFormFrame.classList.remove("hidden");
    setConnectionStatus(true);
    state.heartbeatTimer = window.setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    const bridge = window.chrome && window.chrome.webview;
    if (bridge) bridge.postMessage({ type: "exam-resumed" });
  }

  async function pollNativeAlarmStatus() {
    if (!state.exam || !state.exam.blocked) return;
    const exam = state.exam;
    try {
      const result = await callEndpoint({
        action: "alarm_status",
        nis: exam.nis,
        session_id: exam.sessionId,
        participant_token: exam.participantToken,
      });
      if (state.exam !== exam || !exam.blocked) return;
      if (result.status === "in_exam" || result.status === "logged_in") {
        resumeNativeExam();
        return;
      }
      if (result.status !== "blocked") {
        stopExam("Status ujian berubah. Silakan hubungi pengawas.");
        return;
      }
      notifyNativeHostOfAlarm(result.alarm_active === true);
      setMessage(
        elements.examStopMessage,
        result.alarm_active === true
          ? "Pelanggaran tercatat. Minta pengawas memasukkan kode untuk melanjutkan."
          : "Alarm dimatikan pengawas. Ujian tetap dijeda sampai pengawas mengizinkan lanjut.",
      );
    } catch (error) {
      console.warn("Pemeriksaan status alarm peserta gagal.", error);
    } finally {
      if (state.exam === exam && exam.blocked) {
        state.alarmPollTimer = window.setTimeout(pollNativeAlarmStatus, ALARM_POLL_INTERVAL_MS);
      }
    }
  }

  async function resumeWithNativeProctorCode(code) {
    if (!state.exam || !state.exam.blocked || typeof code !== "string" || !code.trim()) return;
    const exam = state.exam;
    try {
      const result = await callEndpoint({
        action: "resume",
        nis: exam.nis,
        session_id: exam.sessionId,
        participant_token: exam.participantToken,
        proctor_code: code.trim(),
      });
      if (state.exam !== exam || result.status !== "in_exam") return;
      resumeNativeExam();
    } catch (error) {
      const bridge = window.chrome && window.chrome.webview;
      if (bridge) {
        bridge.postMessage({
          type: "resume-error",
          message: error.message || "Kode pengawas tidak dapat diverifikasi.",
        });
      }
    }
  }

  async function recordFocusLoss(force = false) {
    if (!state.exam || state.exam.stopped || (!force && document.visibilityState !== "hidden")) return;
    const exam = state.exam;
    const now = Date.now();
    if (now - state.lastFocusLossAt < FOCUS_LOSS_DEBOUNCE_MS) return;
    state.lastFocusLossAt = now;

    try {
      const payload = {
        action: "focus_loss",
        nis: exam.nis,
        session_id: exam.sessionId,
        participant_token: exam.participantToken,
      };
      const nativeHost = window.chrome && window.chrome.webview;
      if (force && nativeHost) payload.pause_on_violation = true;
      const result = await callEndpoint(payload, { keepalive: true });
      if (state.exam !== exam) return;
      if (force && nativeHost && result.paused === true) {
        blockNativeExam(result);
        return;
      }
      const count = Number(result.violation_count);
      if (Number.isFinite(count)) {
        setMessage(elements.participantAlert, `Peringatan perpindahan tab tercatat (${count} pelanggaran).`);
      }
    } catch (error) {
      if (state.exam !== exam) return;
      const bridge = window.chrome && window.chrome.webview;
      if (force && bridge) {
        if (error.status === 423) {
          blockNativeExam({});
          return;
        }
        bridge.postMessage({
          type: "resume-error",
          message: error.message || "Pelanggaran tidak dapat dicatat ke server.",
        });
      }
      console.warn("Pencatatan perpindahan tab gagal.", error);
    }
  }

  function returnToLogin() {
    notifyNativeHost(false);
    if (state.heartbeatTimer) window.clearInterval(state.heartbeatTimer);
    if (state.alarmPollTimer) window.clearTimeout(state.alarmPollTimer);
    if (state.fallbackTimer) window.clearTimeout(state.fallbackTimer);
    state.heartbeatTimer = null;
    state.alarmPollTimer = null;
    state.fallbackTimer = null;
    state.exam = null;
    elements.nis.value = "";
    elements.lessonToken.value = "";
    elements.roomToken.value = "";
    setMessage(elements.loginError, "");
    setMessage(elements.exitError, "");
    elements.examFormFrame.removeAttribute("src");
    elements.examScreen.classList.add("hidden");
    elements.loginScreen.classList.remove("hidden");
  }

  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage(elements.loginError, "");
    if (!state.config) {
      setMessage(elements.loginError, "Konfigurasi Supabase belum siap. Periksa config/supabase.json.");
      return;
    }

    const nis = elements.nis.value.trim();
    const participantToken = elements.lessonToken.value.trim();
    setBusy(elements.loginButton, true, "Memeriksa...", "Masuk ke ujian");
    try {
      const result = await callEndpoint({
        action: "join",
        nis,
        participant_token: participantToken,
      });
      startExam(result, nis, participantToken);
    } catch (error) {
      setMessage(elements.loginError, error.message || "Tidak dapat masuk. Periksa data dan coba lagi.");
    } finally {
      setBusy(elements.loginButton, false, "Memeriksa...", "Masuk ke ujian");
    }
  });

  elements.requestExit.addEventListener("click", () => {
    setMessage(elements.exitError, "");
    elements.roomToken.value = "";
    elements.exitDialog.showModal();
  });

  elements.exitCancel.addEventListener("click", () => elements.exitDialog.close());

  elements.exitForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.exam) return;
    setMessage(elements.exitError, "");
    setBusy(elements.exitSubmit, true, "Memverifikasi...", "Verifikasi dan keluar");
    try {
      await callEndpoint({
        action: "finish",
        nis: state.exam.nis,
        session_id: state.exam.sessionId,
        room_token: elements.roomToken.value.trim(),
      });
      elements.exitDialog.close();
      returnToLogin();
    } catch (error) {
      setMessage(elements.exitError, error.message || "Token ruang tidak dapat diverifikasi.");
    } finally {
      setBusy(elements.exitSubmit, false, "Memverifikasi...", "Verifikasi dan keluar");
    }
  });

  document.addEventListener("visibilitychange", recordFocusLoss);
  window.addEventListener("examplus-native-focus-loss", () => recordFocusLoss(true));
  window.addEventListener("examplus-native-resume", (event) => {
    resumeWithNativeProctorCode(event.detail);
  });

  if (location.protocol === "file:") {
    elements.localFileWarning.classList.remove("hidden");
  }
  elements.loginButton.disabled = true;
  elements.loginButton.textContent = "Memuat konfigurasi…";
  loadConfig().then((config) => {
    state.config = config;
    setBusy(elements.loginButton, false, "Memuat konfigurasi…", "Masuk ke ujian");
  }).catch((error) => {
    elements.loginButton.textContent = "Masuk ke ujian";
    setMessage(elements.loginError, error.message);
  });
})();
