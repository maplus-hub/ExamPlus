const STORAGE_KEY = "examplus.supabase";
const PAGE_SIZE = 1000;

const state = {
  client: null,
  user: null,
  students: [],
  rooms: [],
  sessions: [],
  workspaceSettings: {
    school_name: "ExamPlus",
    timezone: "Asia/Jakarta",
    default_monitor_session_id: null,
    auto_refresh_seconds: 60
  },
  activeExamCount: 0,
  monitorChannel: null,
  monitorRefreshTimer: null,
  logs: [],
  roomAssignments: [],
  toastTimer: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("visible"), 3800);
}

function errorMessage(error) {
  return error?.message || "Something went wrong. Check the Supabase connection and try again.";
}

function setAuthError(message = "") {
  $("#auth-error").textContent = message;
}

function setSettingsError(message = "") {
  $("#settings-error").textContent = message;
}

function getStoredConfig() {
  try {
    const config = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (config?.url && config?.key) return config;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
  return null;
}

function setApplicationVisible(isVisible) {
  $("#auth-screen").classList.toggle("hidden", isVisible);
  $("#app-shell").classList.toggle("hidden", !isVisible);
}

async function connectSupabase(config) {
  if (!window.supabase?.createClient) throw new Error("Supabase JS did not load. Check your internet connection and reload.");
  state.client = window.supabase.createClient(config.url, config.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  const { data, error } = await state.client.auth.getSession();
  if (error) throw error;
  state.user = data.session?.user || null;
  renderAuthState();
  state.client.auth.onAuthStateChange((_event, session) => {
    state.user = session?.user || null;
    renderAuthState();
  });
}

function renderAuthState() {
  setApplicationVisible(Boolean(state.user));
  $("#connection-status").textContent = state.user ? "Supabase connected" : "Not signed in";
  $("#connection-dot").parentElement.classList.toggle("offline", !state.user);
  if (!state.user) {
    stopMonitorSubscription();
    return;
  }
  $("#current-user").textContent = state.user.email || "Admin";
  $("#top-avatar").textContent = initials(state.user.email || "Admin");
  loadDashboard().catch((error) => showToast(errorMessage(error), true));
}

async function loadDashboard() {
  if (!state.client || !state.user) return;
  const [studentsResult, roomsResult, sessionsResult, workspaceResult] = await Promise.all([
    loadAllStudents(),
    state.client.from("rooms").select("id,room_name,proctor_code,active_token").order("room_name"),
    state.client.from("exam_sessions").select("id,title,gform_url,start_time,end_time,is_active,participant_token").order("start_time", { ascending: false }).limit(200),
    state.client.from("workspace_settings")
      .select("school_name,timezone,default_monitor_session_id,auto_refresh_seconds")
      .eq("id", true)
      .maybeSingle()
  ]);
  for (const result of [roomsResult, sessionsResult, workspaceResult]) if (result.error) throw result.error;
  state.students = studentsResult;
  state.rooms = roomsResult.data || [];
  state.sessions = sessionsResult.data || [];
  if (workspaceResult.data) state.workspaceSettings = workspaceResult.data;
  await loadActiveExamCount();
  renderStudents();
  renderRooms();
  renderSessions();
  renderOverview();
  renderWorkspaceSettings();
  $("#workspace-name").textContent = state.workspaceSettings.school_name;
  $("#workspace-name").classList.toggle("hidden", !state.workspaceSettings.school_name);
  $("#session-start-timezone").textContent = state.workspaceSettings.timezone;
  $("#session-end-timezone").textContent = state.workspaceSettings.timezone;
  renderRoomMappingOptions();
  renderMonitorRoomOptions();
  renderMonitorSessionOptions();
}

async function loadAllStudents() {
  const students = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await state.client.from("students")
      .select("id,nis,name,original_class,device_id,default_room_id")
      .order("original_class")
      .order("nis")
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    students.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return students;
  }
}

function initials(name = "") {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase() || "?";
}

function appendCell(row, content, options = {}) {
  const cell = document.createElement("td");
  if (options.className) cell.className = options.className;
  if (options.node) cell.append(options.node);
  else if (options.html) cell.innerHTML = options.html;
  else cell.textContent = content ?? "—";
  row.append(cell);
  return cell;
}

function studentIdentity(student) {
  const wrapper = document.createElement("div");
  wrapper.className = "student-cell";
  const avatar = document.createElement("span");
  avatar.className = "student-avatar";
  avatar.textContent = initials(student.name);
  const name = document.createElement("strong");
  name.textContent = student.name || "Unnamed student";
  wrapper.append(avatar, name);
  return wrapper;
}

function studentRoomName(student) {
  return state.rooms.find((room) => room.id === student.default_room_id)?.room_name || "";
}

function renderStudents() {
  const query = ($("#student-search").value || "").trim().toLowerCase();
  const filtered = state.students.filter((student) =>
    [student.name, student.nis, student.original_class, studentRoomName(student)]
      .some((value) => String(value || "").toLowerCase().includes(query))
  );
  const body = $("#students-table");
  body.replaceChildren();
  for (const student of filtered) {
    const row = document.createElement("tr");
    appendCell(row, "", { node: studentIdentity(student) });
    appendCell(row, student.nis);
    appendCell(row, student.original_class);
    appendCell(row, studentRoomName(student) || "—");
    const edit = document.createElement("button");
    edit.className = "small-button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openStudentForm(student));
    appendCell(row, "", { node: edit });
    body.append(row);
  }
  $("#student-count").textContent = String(state.students.length);
  $("#students-empty").classList.toggle("hidden", filtered.length > 0);
  if (!filtered.length && state.students.length) {
    $("#students-empty").textContent = "Tidak ada siswa yang cocok dengan pencarian.";
  } else {
    $("#students-empty").textContent = "Belum ada siswa. Impor roster atau tambahkan siswa secara manual.";
  }
}

function openStudentForm(student = null) {
  $("#student-form").reset();
  $("#student-id").value = student?.id || "";
  $("#student-nis").value = student?.nis || "";
  $("#student-name").value = student?.name || "";
  $("#student-class").value = student?.original_class || "";
  const roomSelect = $("#student-room");
  roomSelect.replaceChildren(new Option("Belum ditentukan", ""));
  for (const room of state.rooms) roomSelect.add(new Option(room.room_name, room.id));
  roomSelect.value = student?.default_room_id || "";
  $("#student-form-title").textContent = student ? "Edit data siswa" : "Tambah siswa";
  $("#save-student-button").textContent = student ? "Simpan perubahan" : "Simpan siswa";
  $("#student-form-wrap").classList.remove("hidden");
  $("#student-form-wrap").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function saveStudent(event) {
  event.preventDefault();
  const studentId = $("#student-id").value;
  const student = {
    nis: $("#student-nis").value.trim(),
    name: $("#student-name").value.trim(),
    original_class: $("#student-class").value.trim(),
    default_room_id: $("#student-room").value || null
  };
  if (!student.nis || !student.name || !student.original_class) {
    showToast("NIS, nama, dan kelas asal wajib diisi.", true);
    return;
  }
  const button = $("#save-student-button");
  button.disabled = true;
  try {
    const result = studentId
      ? await state.client.from("students").update(student).eq("id", studentId)
      : await state.client.from("students").insert(student);
    if (result.error) throw result.error;
    $("#student-form-wrap").classList.add("hidden");
    $("#student-form").reset();
    await loadDashboard();
    showToast(studentId ? "Data siswa diperbarui." : "Siswa berhasil ditambahkan.");
  } catch (error) {
    showToast(errorMessage(error), true);
  } finally {
    button.disabled = false;
  }
}

function downloadStudentTemplate() {
  if (!window.XLSX) {
    showToast("Pembuat file Excel belum tersedia. Muat ulang halaman.", true);
    return;
  }
  const workbook = XLSX.utils.book_new();
  const students = XLSX.utils.aoa_to_sheet([["nis", "name", "original_class", "room"]]);
  students["!cols"] = [{ wch: 18 }, { wch: 30 }, { wch: 20 }, { wch: 24 }];
  students["!autofilter"] = { ref: "A1:D1" };
  XLSX.utils.book_append_sheet(workbook, students, "Siswa");
  const guide = XLSX.utils.aoa_to_sheet([
    ["Panduan impor siswa"],
    ["Kolom", "Wajib", "Keterangan"],
    ["nis", "Ya", "Nomor induk siswa; harus unik."],
    ["name", "Ya", "Nama lengkap siswa."],
    ["original_class", "Ya", "Kelas asal siswa."],
    ["room", "Tidak", "Nama ruang default sesuai yang tertulis pada daftar ruang."],
    ["nis", "", "Atur kolom NIS sebagai Teks agar angka nol di depan tidak hilang."],
    ["Catatan", "", "Isi data pada sheet Siswa. Jangan mengganti nama header."],
    ["Catatan", "", "Kolom room boleh dikosongkan; penempatan yang sudah diatur per pelajaran tidak berubah."]
  ]);
  guide["!cols"] = [{ wch: 22 }, { wch: 12 }, { wch: 62 }];
  XLSX.utils.book_append_sheet(workbook, guide, "Panduan");
  XLSX.writeFile(workbook, "template-impor-siswa-examplus.xlsx");
}

function renderRooms() {
  const body = $("#rooms-table");
  body.replaceChildren();
  for (const room of state.rooms) {
    const row = document.createElement("tr");
    appendCell(row, room.room_name);
    appendCell(row, room.proctor_code);
    const token = document.createElement("strong");
    token.textContent = room.active_token || "—";
    const tokenCell = appendCell(row, "", { node: token });
    if (room.active_token) {
      const copy = document.createElement("button");
      copy.className = "text-button";
      copy.textContent = "Salin";
      copy.addEventListener("click", () => copyToken(room.active_token, "Token ruang"));
      tokenCell.append(copy);
    }
    const actions = document.createElement("div");
    actions.className = "room-actions";
    const edit = document.createElement("button");
    edit.className = "small-button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openRoomForm(room));
    const roster = document.createElement("button");
    roster.className = "small-button";
    roster.textContent = "Lihat roster";
    roster.addEventListener("click", () => {
      showView("rooms");
      $("#mapping-room").value = room.id;
      if (!$("#mapping-session").value && state.sessions.length) {
        $("#mapping-session").value = state.sessions.find((session) => session.is_active)?.id || state.sessions[0].id;
      }
      loadRoomMapping().catch((error) => showToast(errorMessage(error), true));
      $("#room-mapping-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    actions.append(edit, roster);
    appendCell(row, "", { node: actions });
    body.append(row);
  }
  $("#rooms-empty").classList.toggle("hidden", state.rooms.length > 0);
  $("#stat-rooms").textContent = String(state.rooms.length);
}

function openRoomForm(room = null) {
  $("#room-form").reset();
  $("#room-id").value = room?.id || "";
  $("#room-name").value = room?.room_name || "";
  $("#room-proctor-code").value = room?.proctor_code || "";
  $("#room-form-title").textContent = room ? "Edit data ruang" : "Tambah ruang ujian";
  $("#save-room-button").textContent = room ? "Simpan perubahan" : "Simpan ruang";
  $("#room-form-wrap").classList.remove("hidden");
  $("#room-form-wrap").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function createRoom(event) {
  event.preventDefault();
  const roomId = $("#room-id").value;
  const roomName = $("#room-name").value.trim();
  const proctorCode = $("#room-proctor-code").value.trim();
  if (!roomName || proctorCode.length < 8) {
    showToast("Isi nama ruang dan kode pengawas minimal 8 karakter.", true);
    return;
  }
  const room = {
    room_name: roomName,
    proctor_code: proctorCode
  };
  if (!roomId) {
    room.active_token = uniqueToken([
      ...state.rooms.map((item) => item.active_token),
      ...state.sessions.map((session) => session.participant_token)
    ]);
  }
  const result = roomId
    ? await state.client.from("rooms").update(room).eq("id", roomId)
    : await state.client.from("rooms").insert(room);
  if (result.error) {
    showToast(errorMessage(result.error), true);
    return;
  }
  $("#room-form").reset();
  $("#room-form-wrap").classList.add("hidden");
  await loadDashboard();
  showToast(roomId ? "Data ruang diperbarui." : "Ruang dan token ruang berhasil disimpan.");
}

function renderRoomMappingOptions() {
  const sessionSelect = $("#mapping-session");
  const previousSession = sessionSelect.value;
  sessionSelect.replaceChildren(new Option("Pilih pelajaran", ""));
  for (const session of state.sessions) {
    sessionSelect.add(new Option(session.title || "Pelajaran tanpa nama", session.id));
  }
  if (state.sessions.some((session) => session.id === previousSession)) {
    sessionSelect.value = previousSession;
  } else if (state.sessions.length) {
    sessionSelect.value = state.sessions.find((session) => session.is_active)?.id || state.sessions[0].id;
  }

  const roomSelect = $("#mapping-room");
  const previousRoom = roomSelect.value;
  roomSelect.replaceChildren(new Option("Semua ruang", ""));
  for (const room of state.rooms) roomSelect.add(new Option(room.room_name, room.id));
  if (state.rooms.some((room) => room.id === previousRoom)) roomSelect.value = previousRoom;
  else roomSelect.value = "";
  loadRoomMapping().catch((error) => showToast(errorMessage(error), true));
}

async function fetchSessionAllocations(sessionId) {
  const allocations = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await state.client.from("participant_allocations")
      .select("id,student_id,room_id,session_id,seat_number")
      .eq("session_id", sessionId)
      .order("room_id")
      .order("seat_number")
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    allocations.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return allocations;
  }
}

async function loadRoomMapping() {
  const sessionId = $("#mapping-session").value;
  const roomId = $("#mapping-room").value;
  if (!sessionId) {
    state.roomAssignments = [];
    renderRoomMapping();
    return;
  }
  const allocations = await fetchSessionAllocations(sessionId);
  const students = new Map(state.students.map((student) => [student.id, student]));
  state.roomAssignments = allocations.map((allocation) => ({
    ...allocation,
    student: students.get(allocation.student_id)
  })).sort((left, right) => {
    const roomOrder = (state.rooms.find((room) => room.id === left.room_id)?.room_name || "")
      .localeCompare(state.rooms.find((room) => room.id === right.room_id)?.room_name || "");
    return roomOrder || left.seat_number - right.seat_number;
  });
  if ($("#mapping-session").value !== sessionId) return;
  renderRoomMapping(roomId);
}

function renderRoomMapping(roomId = $("#mapping-room").value) {
  const body = $("#mapping-table");
  body.replaceChildren();
  const allocations = roomId
    ? state.roomAssignments.filter((allocation) => allocation.room_id === roomId)
    : state.roomAssignments;
  for (const allocation of allocations) {
    const row = document.createElement("tr");
    appendCell(row, state.rooms.find((room) => room.id === allocation.room_id)?.room_name || "Ruang tidak dikenal");
    appendCell(row, String(allocation.seat_number));
    appendCell(row, "", { node: studentIdentity(allocation.student || { name: "Peserta tidak ditemukan" }) });
    appendCell(row, allocation.student?.nis);
    appendCell(row, allocation.student?.original_class);
    const controls = document.createElement("div");
    controls.className = "room-assignment-actions";
    const roomSelect = document.createElement("select");
    for (const room of state.rooms) roomSelect.add(new Option(room.room_name, room.id));
    roomSelect.value = allocation.room_id;
    const move = document.createElement("button");
    move.className = "small-button";
    move.textContent = "Pindahkan";
    move.disabled = state.rooms.length < 2 || roomSelect.value === allocation.room_id;
    roomSelect.addEventListener("change", () => {
      move.disabled = state.rooms.length < 2 || roomSelect.value === allocation.room_id;
    });
    move.addEventListener("click", () => moveAllocation(allocation, roomSelect.value)
      .catch((error) => showToast(errorMessage(error), true)));
    controls.append(roomSelect, move);
    appendCell(row, "", { node: controls });
    body.append(row);
  }
  const hasSession = Boolean($("#mapping-session").value);
  $("#mapping-empty").classList.toggle("hidden", allocations.length > 0);
  $("#mapping-empty").textContent = !hasSession
    ? "Pilih pelajaran untuk membaca pemetaan ruang."
    : allocations.length
      ? ""
      : "Belum ada pemetaan untuk pilihan ini. Atur ruang dari halaman Pelajaran.";
  $("#mapping-count").textContent = hasSession && state.roomAssignments.length
    ? `${allocations.length} peserta ditampilkan · ${new Set(state.roomAssignments.map((item) => item.room_id)).size} ruang pada pelajaran`
    : "";
  $("#export-roster-button").disabled = allocations.length === 0;
}

async function moveAllocation(allocation, roomId) {
  if (!state.rooms.some((room) => room.id === roomId)) throw new Error("Pilih ruang yang valid.");
  if (roomId === allocation.room_id) return;
  const lesson = state.sessions.find((session) => session.id === allocation.session_id);
  if (lesson?.is_active && !window.confirm("Pelajaran sedang aktif. Memindahkan peserta dapat mengubah token ruang yang diperlukan untuk keluar. Lanjutkan?")) {
    return;
  }
  const { data: destination, error: destinationError } = await state.client.from("participant_allocations")
    .select("seat_number")
    .eq("session_id", allocation.session_id)
    .eq("room_id", roomId);
  if (destinationError) throw destinationError;
  const occupiedSeats = new Set((destination || []).map((item) => item.seat_number));
  let seatNumber = 1;
  while (occupiedSeats.has(seatNumber)) seatNumber += 1;
  const { error } = await state.client.from("participant_allocations")
    .update({ room_id: roomId, seat_number: seatNumber })
    .eq("id", allocation.id);
  if (error) throw error;
  if ($("#mapping-session").value === allocation.session_id) await loadRoomMapping();
  if ($("#monitor-session").value === allocation.session_id) await refreshMonitorLogs(allocation.session_id);
  showToast("Penempatan ruang peserta diperbarui.");
}

function exportRoomRoster() {
  const sessionId = $("#mapping-session").value;
  const selectedRoomId = $("#mapping-room").value;
  const rows = state.roomAssignments.filter((allocation) => !selectedRoomId || allocation.room_id === selectedRoomId);
  if (!sessionId || !rows.length) {
    showToast("Tidak ada roster untuk diekspor.", true);
    return;
  }
  const sessionTitle = state.sessions.find((session) => session.id === sessionId)?.title || "Pelajaran";
  const csvEscape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const csv = [
    ["Pelajaran", "Ruang", "Kursi", "NIS", "Nama", "Kelas"],
    ...rows.map((allocation) => [
      sessionTitle,
      state.rooms.find((room) => room.id === allocation.room_id)?.room_name || "",
      allocation.seat_number,
      allocation.student?.nis || "",
      allocation.student?.name || "",
      allocation.student?.original_class || ""
    ])
  ].map((row) => row.map(csvEscape).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `roster-${sessionTitle.replace(/[^\w-]+/g, "-").toLowerCase()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function formatDate(value, includeTime = true) {
  if (!value) return "Time not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid time";
  return new Intl.DateTimeFormat(undefined, includeTime
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: state.workspaceSettings.timezone }
    : { month: "short", day: "numeric", year: "numeric", timeZone: state.workspaceSettings.timezone }).format(date);
}

function sessionStatus(session) {
  if (session.is_active) return { text: "Aktif", className: "status-active" };
  if (session.end_time && new Date(session.end_time) < new Date()) return { text: "Selesai", className: "status-closed" };
  return { text: "Akan datang", className: "status-upcoming" };
}

function createStatusPill(status) {
  const pill = document.createElement("span");
  const normalized = String(status.text).toLowerCase().replace(/\s+/g, "-");
  pill.className = `status-pill ${status.className || `status-${normalized}`}`;
  pill.textContent = status.text;
  return pill;
}

function makeSessionRow(session, compact = false) {
  const row = document.createElement("div");
  row.className = "session-row";
  const main = document.createElement("div");
  main.className = "session-main";
  const title = document.createElement("strong");
  title.textContent = session.title || "Pelajaran tanpa nama";
  const dates = document.createElement("small");
  dates.textContent = `${formatDate(session.start_time)} — ${formatDate(session.end_time)}`;
  main.append(title, dates);
  const controls = document.createElement("div");
  controls.className = "session-controls";
  controls.append(createStatusPill(sessionStatus(session)));
  if (!compact) {
    const tokenRow = document.createElement("div");
    tokenRow.className = "session-token-row";
    const tokenText = document.createElement("strong");
    tokenText.textContent = session.participant_token || "Belum ada";
    const tokenLabel = document.createElement("small");
    tokenLabel.textContent = "Token pelajaran";
    tokenRow.append(tokenLabel, tokenText);
    if (session.participant_token) {
      const copy = document.createElement("button");
      copy.className = "text-button";
      copy.textContent = "Salin";
      copy.addEventListener("click", () => copyToken(session.participant_token, "Token pelajaran"));
      tokenRow.append(copy);
    }
    main.append(tokenRow);

    const participantToken = document.createElement("button");
    participantToken.className = "small-button";
    participantToken.textContent = session.participant_token ? "Ganti token" : "Buat token";
    participantToken.disabled = Boolean(session.is_active && session.participant_token);
    participantToken.title = participantToken.disabled
      ? "Tutup pelajaran sebelum mengganti token pelajaran."
      : "Buat atau ganti token login peserta";
    participantToken.addEventListener("click", () => setSessionParticipantToken(session)
      .catch((error) => showToast(errorMessage(error), true)));
    controls.append(participantToken);

    const edit = document.createElement("button");
    edit.className = "small-button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openSessionForm(session));
    controls.append(edit);

    const shuffle = document.createElement("button");
    shuffle.className = "small-button";
    shuffle.textContent = "Atur ruang";
    shuffle.disabled = !state.rooms.length || !state.students.length;
    shuffle.title = shuffle.disabled ? "Tambahkan siswa dan ruang terlebih dahulu." : "Buat alokasi ruang lintas kelas";
    shuffle.addEventListener("click", () => allocateSession(session).catch((error) => showToast(errorMessage(error), true)));
    controls.append(shuffle);
    const toggle = document.createElement("button");
    toggle.className = `small-button${session.is_active ? " button-danger" : ""}`;
    toggle.textContent = session.is_active ? "Tutup" : "Aktifkan";
    toggle.addEventListener("click", () => toggleSession(session).catch((error) => showToast(errorMessage(error), true)));
    controls.append(toggle);
  }
  row.append(main, controls);
  return row;
}

function renderSessions() {
  const list = $("#sessions-list");
  list.replaceChildren();
  if (!state.sessions.length) {
    list.innerHTML = '<div class="empty-state">Belum ada pelajaran. Buat pelajaran pertama.</div>';
  } else {
    state.sessions.forEach((session) => list.append(makeSessionRow(session)));
  }
  const overview = $("#overview-sessions");
  overview.replaceChildren();
  if (!state.sessions.length) overview.innerHTML = '<div class="empty-state">Belum ada pelajaran.</div>';
  else state.sessions.slice(0, 4).forEach((session) => overview.append(makeSessionRow(session, true)));
  $("#stat-sessions").textContent = String(state.sessions.filter((session) => session.is_active).length);
}

function renderOverview() {
  $("#stat-students").textContent = String(state.students.length);
  $("#stat-in-exam").textContent = String(state.activeExamCount);
}

function renderWorkspaceSettings() {
  const settings = state.workspaceSettings;
  $("#workspace-school-name").value = settings.school_name || "ExamPlus";
  $("#workspace-timezone").value = settings.timezone || "Asia/Jakarta";
  $("#workspace-refresh-interval").value = String(settings.auto_refresh_seconds ?? 60);
  const select = $("#workspace-default-session");
  const selected = settings.default_monitor_session_id || "";
  select.replaceChildren(new Option("Pilih pelajaran aktif otomatis", ""));
  for (const session of state.sessions) {
    select.add(new Option(session.title || "Pelajaran tanpa nama", session.id));
  }
  select.value = state.sessions.some((session) => session.id === selected) ? selected : "";
}

async function loadActiveExamCount() {
  const activeSessionIds = state.sessions.filter((session) => session.is_active).map((session) => session.id);
  if (!activeSessionIds.length) {
    state.activeExamCount = 0;
    return;
  }
  const { count, error } = await state.client.from("exam_logs")
    .select("id", { count: "exact", head: true })
    .in("session_id", activeSessionIds)
    .eq("status", "in_exam");
  if (error) throw error;
  state.activeExamCount = count || 0;
}

function renderMonitorSessionOptions() {
  const select = $("#monitor-session");
  const selected = select.value;
  select.replaceChildren(new Option("Pilih pelajaran", ""));
  for (const session of state.sessions) select.add(new Option(session.title || "Pelajaran tanpa nama", session.id));
  if (state.sessions.some((session) => session.id === selected)) select.value = selected;
  else if (state.sessions.some((session) => session.id === state.workspaceSettings.default_monitor_session_id)) {
    select.value = state.workspaceSettings.default_monitor_session_id;
  }
  else if (state.sessions.some((session) => session.is_active)) {
    select.value = state.sessions.find((session) => session.is_active).id;
  }
  if (select.value) loadMonitorLogs().catch((error) => showToast(errorMessage(error), true));
}

function renderMonitorRoomOptions() {
  const select = $("#monitor-room");
  const selected = select.value;
  select.replaceChildren(new Option("Semua ruang", ""));
  for (const room of state.rooms) select.add(new Option(room.room_name, room.id));
  if (state.rooms.some((room) => room.id === selected)) select.value = selected;
  else select.value = "";
  renderMonitor();
}

function stopMonitorSubscription() {
  if (state.monitorRefreshTimer) {
    clearInterval(state.monitorRefreshTimer);
    state.monitorRefreshTimer = null;
  }
  if (state.monitorChannel && state.client) {
    state.client.removeChannel(state.monitorChannel);
    state.monitorChannel = null;
  }
}

function setRealtimeState(connected, message) {
  const element = $("#realtime-state");
  element.classList.toggle("offline", !connected);
  element.lastChild.textContent = ` ${message}`;
}

async function loadMonitorLogs() {
  if (!state.client || !state.user) return;
  const sessionId = $("#monitor-session").value;
  stopMonitorSubscription();
  state.logs = [];
  renderMonitor();
  if (!sessionId) {
    setRealtimeState(false, "Menunggu pelajaran");
    renderOverview();
    return;
  }
  state.monitorChannel = state.client.channel(`exam-logs-${sessionId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "exam_logs", filter: `session_id=eq.${sessionId}` }, () => {
      refreshMonitorLogs(sessionId).catch((error) => showToast(errorMessage(error), true));
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") setRealtimeState(true, "Live updates on");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setRealtimeState(false, "Realtime unavailable");
    });
  await refreshMonitorLogs(sessionId);
  const intervalSeconds = Number(state.workspaceSettings.auto_refresh_seconds);
  if (intervalSeconds > 0) {
    state.monitorRefreshTimer = setInterval(() => {
      refreshMonitorLogs(sessionId).catch((error) => showToast(errorMessage(error), true));
    }, intervalSeconds * 1000);
  }
}

async function refreshMonitorLogs(sessionId) {
  if (!state.client || $("#monitor-session").value !== sessionId) return;
  const [allocations, logs] = await Promise.all([
    fetchSessionAllocations(sessionId),
    fetchSessionLogs(sessionId)
  ]);
  const students = new Map(state.students.map((student) => [student.id, student]));
  state.logs = buildMonitorRoster(allocations, logs, students);
  state.roomNames = new Map(state.rooms.map((room) => [room.id, room.room_name]));
  if ($("#monitor-session").value !== sessionId) return;
  await loadActiveExamCount();
  renderMonitor();
  renderOverview();
}

function buildMonitorRoster(allocations, logs, students) {
  const logsByStudent = new Map(logs.map((log) => [log.student_id, log]));
  const allocatedStudentIds = new Set(allocations.map((allocation) => allocation.student_id));
  const roster = allocations.map((allocation) => {
    const log = logsByStudent.get(allocation.student_id);
    return {
      id: log?.id || null,
      student_id: allocation.student_id,
      status: log?.status || "not_started",
      violation_count: log?.violation_count || 0,
      last_heartbeat: log?.last_heartbeat || null,
      student: students.get(allocation.student_id),
      allocation
    };
  });
  for (const log of logs) {
    if (!allocatedStudentIds.has(log.student_id)) {
      roster.push({ ...log, student: students.get(log.student_id), allocation: null });
    }
  }
  return roster.sort((left, right) =>
    (left.student?.name || "").localeCompare(right.student?.name || "")
  );
}

async function fetchSessionLogs(sessionId) {
  const logs = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await state.client.from("exam_logs")
      .select("id,student_id,session_id,status,violation_count,last_heartbeat")
      .eq("session_id", sessionId)
      .order("id")
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    logs.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return logs;
  }
}

function renderMonitor() {
  const body = $("#monitor-table");
  body.replaceChildren();
  const roomId = $("#monitor-room").value;
  const visibleLogs = roomId
    ? state.logs.filter((log) => log.allocation?.room_id === roomId)
    : state.logs;
  const counts = { not_started: 0, logged_in: 0, in_exam: 0, finished: 0, blocked: 0 };
  for (const log of visibleLogs) {
    if (Object.hasOwn(counts, log.status)) counts[log.status] += 1;
    const row = document.createElement("tr");
    appendCell(row, "", { node: studentIdentity(log.student || { name: "Unknown student" }) });
    const allocation = log.allocation;
    const roomLabel = allocation
      ? `${state.roomNames?.get(allocation.room_id) || "Room"} · Seat ${allocation.seat_number ?? "—"}`
      : "Not allocated";
    appendCell(row, roomLabel);
    const statusText = log.status === "not_started"
      ? "Belum masuk"
      : String(log.status || "unknown").replaceAll("_", " ");
    const statusCell = appendCell(row, "");
    statusCell.append(createStatusPill({ text: statusText, className: `status-${log.status || "unknown"}` }));
    appendCell(row, String(log.violation_count ?? 0));
    appendCell(row, formatDate(log.last_heartbeat));
    const actionCell = document.createElement("td");
    if (log.status === "blocked") {
      const unblock = document.createElement("button");
      unblock.className = "small-button";
      unblock.textContent = "Unblock";
      unblock.addEventListener("click", () => unblockStudent(log).catch((error) => showToast(errorMessage(error), true)));
      actionCell.append(unblock);
    } else {
      actionCell.textContent = "—";
    }
    row.append(actionCell);
    body.append(row);
  }
  $("#monitor-not-started").textContent = String(counts.not_started);
  $("#monitor-logged-in").textContent = String(counts.logged_in);
  $("#monitor-in-exam").textContent = String(counts.in_exam);
  $("#monitor-finished").textContent = String(counts.finished);
  $("#monitor-blocked").textContent = String(counts.blocked);
  $("#monitor-total").textContent = `${visibleLogs.length} peserta`;
  $("#monitor-empty").classList.toggle("hidden", visibleLogs.length > 0 || !$("#monitor-session").value);
  if ($("#monitor-session").value && visibleLogs.length === 0) {
    $("#monitor-empty").textContent = "Belum ada peserta pada pelajaran atau ruang yang dipilih.";
  }
}

async function unblockStudent(log) {
  const { error } = await state.client.from("exam_logs")
    .update({ status: "logged_in", violation_count: 0 })
    .eq("id", log.id);
  if (error) throw error;
  showToast("Student unblocked.");
  await loadMonitorLogs();
}

async function importStudentFile(file) {
  if (!file || !window.XLSX) throw new Error("Spreadsheet reader did not load. Reload the page and try again.");
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: "array", raw: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The selected file has no worksheet.");
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  if (!rows.length) throw new Error("No student rows found in the selected file.");
  const students = [];
  const seen = new Set();
  const existingByNis = new Map(state.students.map((student) => [student.nis, student]));
  const roomsByName = new Map(state.rooms.map((room) => [room.room_name.trim().toLowerCase(), room.id]));
  for (const raw of rows) {
    const student = mapStudentImportRow(raw);
    if (!student.nis || !student.name || !student.original_class) {
      throw new Error("Each row needs nis, name, and original_class (or class). Fix the file and re-import.");
    }
    if (seen.has(student.nis)) throw new Error(`Duplicate NIS "${student.nis}" found in the file.`);
    seen.add(student.nis);
    if (student.has_room_column) {
      const roomName = student.default_room_name.trim().toLowerCase();
      if (roomName && !roomsByName.has(roomName)) {
        throw new Error(`Ruang "${student.default_room_name}" tidak ditemukan. Gunakan nama yang sama dengan daftar ruang.`);
      }
      student.default_room_id = roomName ? roomsByName.get(roomName) : null;
    } else {
      student.default_room_id = existingByNis.get(student.nis)?.default_room_id || null;
    }
    if (!student.has_device_id_column) {
      student.device_id = existingByNis.get(student.nis)?.device_id || null;
    }
    delete student.default_room_name;
    delete student.has_room_column;
    delete student.has_device_id_column;
    students.push(student);
  }
  for (let offset = 0; offset < students.length; offset += 500) {
    const batch = students.slice(offset, offset + 500);
    const { error } = await state.client.from("students").upsert(batch, { onConflict: "nis" });
    if (error) throw new Error(`Import stopped after ${offset} of ${students.length} rows: ${error.message}`);
  }
  await loadDashboard();
  showToast(`${students.length} siswa berhasil diimpor.`);
}

function mapStudentImportRow(raw) {
  const normalize = (value) => String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const values = Object.fromEntries(Object.entries(raw).map(([key, value]) => [normalize(key), String(value).trim()]));
  const roomHeaders = ["room", "room_name", "default_room", "ruang", "ruang_default"];
  return {
    nis: values.nis || values.nis_nip || values.student_id || values.student_number || "",
    name: values.name || values.nama || values.nama_lengkap || values.student_name || "",
    original_class: values.original_class || values.kelas_asal || values.class || values.kelas || values.class_name || "",
    device_id: values.device_id || values.id_perangkat || null,
    default_room_name: roomHeaders.map((header) => values[header]).find((value) => value !== undefined) || "",
    has_room_column: roomHeaders.some((header) => Object.prototype.hasOwnProperty.call(values, header)),
    has_device_id_column: ["device_id", "id_perangkat"].some((header) => Object.prototype.hasOwnProperty.call(values, header))
  };
}

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

function createAllocations(students, rooms, sessionId) {
  if (!students.length || !rooms.length) throw new Error("Add at least one student and one room before shuffling.");
  const byClass = new Map();
  for (const student of students) {
    const className = student.original_class || "Unassigned";
    if (!byClass.has(className)) byClass.set(className, []);
    byClass.get(className).push(student);
  }
  const roomCounts = new Map(rooms.map((room) => [room.id, 0]));
  const assignments = [];
  for (const classStudents of byClass.values()) {
    const classCounts = new Map(rooms.map((room) => [room.id, 0]));
    for (const student of shuffle(classStudents)) {
      const defaultRoom = rooms.find((room) => room.id === student.default_room_id);
      let room = defaultRoom;
      if (!room) {
        const leastRepresented = Math.min(...rooms.map((candidate) => classCounts.get(candidate.id)));
        const candidates = rooms.filter((candidate) => classCounts.get(candidate.id) === leastRepresented);
        const leastLoaded = Math.min(...candidates.map((candidate) => roomCounts.get(candidate.id)));
        room = shuffle(candidates.filter((candidate) => roomCounts.get(candidate.id) === leastLoaded))[0];
      }
      assignments.push({ student_id: student.id, room_id: room.id, session_id: sessionId });
      classCounts.set(room.id, classCounts.get(room.id) + 1);
      roomCounts.set(room.id, roomCounts.get(room.id) + 1);
    }
  }
  const seats = new Map(rooms.map((room) => [room.id, 0]));
  for (const assignment of shuffle(assignments)) {
    seats.set(assignment.room_id, seats.get(assignment.room_id) + 1);
    assignment.seat_number = seats.get(assignment.room_id);
  }
  return assignments;
}

async function allocateSession(session) {
  const { data: existing, error: existingError } = await state.client.from("participant_allocations")
    .select("id,student_id")
    .eq("session_id", session.id);
  if (existingError) throw existingError;
  if (existing?.length && !window.confirm(
    `Pelajaran ini sudah memiliki ${existing.length} alokasi. Lanjutkan untuk mengubah penempatan ruang? Peserta yang sedang ujian mungkin perlu koordinasi ulang.`
  )) return;
  const assignments = createAllocations(state.students, state.rooms, session.id);
  const existingByStudent = new Map();
  for (const allocation of existing || []) {
    if (!existingByStudent.has(allocation.student_id)) existingByStudent.set(allocation.student_id, allocation.id);
  }
  for (const assignment of assignments) {
    assignment.id = existingByStudent.get(assignment.student_id) || crypto.randomUUID();
  }
  for (let offset = 0; offset < assignments.length; offset += 500) {
    const batch = assignments.slice(offset, offset + 500);
    const { error } = await state.client.from("participant_allocations").upsert(batch);
    if (error) throw new Error(`Allocation save stopped after ${offset} of ${assignments.length} students: ${error.message}`);
  }
  const currentStudentIds = new Set(assignments.map((allocation) => allocation.student_id));
  const staleIds = (existing || []).filter((allocation) => !currentStudentIds.has(allocation.student_id)).map((allocation) => allocation.id);
  for (let offset = 0; offset < staleIds.length; offset += 500) {
    const { error: cleanupError } = await state.client.from("participant_allocations").delete().in("id", staleIds.slice(offset, offset + 500));
    if (cleanupError) throw new Error(`Allocations were saved, but old roster entries could not be removed: ${cleanupError.message}`);
  }
  if ($("#mapping-session").value === session.id) await loadRoomMapping();
  if ($("#monitor-session").value === session.id) await refreshMonitorLogs(session.id);
  showToast(`${assignments.length} peserta dialokasikan ke ${state.rooms.length} ruang.`);
}

async function toggleSession(session) {
  const { error } = await state.client.from("exam_sessions").update({ is_active: !session.is_active }).eq("id", session.id);
  if (error) throw error;
  await loadDashboard();
  showToast(session.is_active ? "Pelajaran ditutup." : "Pelajaran diaktifkan.");
}

function validateFormUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid Google Forms URL.");
  }
  if (url.protocol !== "https:" || !/docs\.google\.com$/i.test(url.hostname)) {
    throw new Error("Use an HTTPS Google Forms link from docs.google.com.");
  }
  return url.toString();
}

function parseWorkspaceDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Pilih tanggal dan waktu ujian yang valid.");
  const desired = match.slice(1).map(Number);
  const [year, month, day, hour, minute] = desired;
  const desiredTimestamp = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: state.workspaceSettings.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  let timestamp = desiredTimestamp;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, Number(part.value)]));
    const observedTimestamp = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const correction = desiredTimestamp - observedTimestamp;
    timestamp += correction;
    if (correction === 0) break;
  }
  const finalParts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, Number(part.value)]));
  if (year !== finalParts.year || month !== finalParts.month || day !== finalParts.day ||
      hour !== finalParts.hour || minute !== finalParts.minute) {
    throw new Error("Waktu tersebut tidak valid pada zona waktu workspace.");
  }
  return new Date(timestamp);
}

function formatWorkspaceDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Jadwal pelajaran yang tersimpan tidak valid.");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: state.workspaceSettings.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function openSessionForm(session = null) {
  $("#session-form").reset();
  $("#session-id").value = session?.id || "";
  $("#session-title").value = session?.title || "";
  $("#session-url").value = session?.gform_url || "";
  $("#session-start").value = session ? formatWorkspaceDateTime(session.start_time) : "";
  $("#session-end").value = session ? formatWorkspaceDateTime(session.end_time) : "";
  $("#session-form-title").textContent = session ? "Edit pelajaran" : "Buat pelajaran";
  $("#save-session-button").textContent = session ? "Simpan perubahan" : "Simpan pelajaran";
  $("#session-form-wrap").classList.remove("hidden");
  $("#session-form-wrap").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function saveWorkspaceSettings(event) {
  event.preventDefault();
  $("#workspace-settings-error").textContent = "";
  const schoolName = $("#workspace-school-name").value.trim();
  const timezone = $("#workspace-timezone").value.trim();
  const refreshSeconds = Number($("#workspace-refresh-interval").value);
  try {
    if (!schoolName) throw new Error("Nama sekolah/workspace wajib diisi.");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    } catch {
      throw new Error("Masukkan nama zona waktu IANA yang valid, misalnya Asia/Jakarta.");
    }
    if (![0, 30, 60, 120].includes(refreshSeconds)) throw new Error("Interval refresh tidak valid.");
    const settings = {
      id: true,
      school_name: schoolName,
      timezone,
      default_monitor_session_id: $("#workspace-default-session").value || null,
      auto_refresh_seconds: refreshSeconds,
      updated_by: state.user.id,
      updated_at: new Date().toISOString()
    };
    const { error } = await state.client.from("workspace_settings").upsert(settings, { onConflict: "id" });
    if (error) throw error;
    state.workspaceSettings = settings;
    $("#workspace-name").textContent = schoolName;
    $("#workspace-name").classList.remove("hidden");
    $("#session-start-timezone").textContent = timezone;
    $("#session-end-timezone").textContent = timezone;
    renderSessions();
    renderMonitor();
    if ($("#monitor-session").value) await loadMonitorLogs();
    showToast("Preferensi workspace berhasil disimpan.");
  } catch (error) {
    $("#workspace-settings-error").textContent = errorMessage(error);
  }
}

async function createSession(event) {
  event.preventDefault();
  try {
    const start = parseWorkspaceDateTime($("#session-start").value);
    const end = parseWorkspaceDateTime($("#session-end").value);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      throw new Error("Choose a valid exam window; the end time must be after the start.");
    }
    const session = {
      title: $("#session-title").value.trim(),
      gform_url: validateFormUrl($("#session-url").value.trim()),
      start_time: start.toISOString(),
      end_time: end.toISOString()
    };
    const sessionId = $("#session-id").value;
    const result = sessionId
      ? await state.client.from("exam_sessions").update(session).eq("id", sessionId)
      : await state.client.from("exam_sessions").insert({
        ...session,
        is_active: false,
        participant_token: uniqueToken([
          ...state.sessions.map((item) => item.participant_token),
          ...state.rooms.map((room) => room.active_token)
        ])
      });
    const { error } = result;
    if (error) throw error;
    $("#session-form").reset();
    $("#session-form-wrap").classList.add("hidden");
    await loadDashboard();
    showToast(sessionId ? "Jadwal pelajaran diperbarui." : "Pelajaran berhasil dibuat.");
  } catch (error) {
    showToast(errorMessage(error), true);
  }
}

function randomToken() {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(bytes[0] % 1000000).padStart(6, "0");
}

function uniqueToken(usedTokens) {
  const used = new Set(usedTokens.filter(Boolean));
  let token = randomToken();
  while (used.has(token)) token = randomToken();
  return token;
}

async function copyToken(token, label) {
  try {
    await navigator.clipboard.writeText(token);
    showToast(`${label} disalin.`);
  } catch {
    showToast(`Tidak dapat menyalin otomatis. Salin token ini secara manual: ${token}`, true);
  }
}

async function setSessionParticipantToken(session) {
  if (session.is_active && session.participant_token) {
    throw new Error("Tutup pelajaran sebelum mengganti token pelajaran.");
  }
  if (session.participant_token &&
      !window.confirm("Ganti token pelajaran? Peserta harus memakai token baru untuk login berikutnya.")) return;
  const token = uniqueToken([
    ...state.sessions.map((item) => item.participant_token),
    ...state.rooms.map((room) => room.active_token)
  ]);
  const { error } = await state.client.from("exam_sessions")
    .update({ participant_token: token })
    .eq("id", session.id);
  if (error) throw error;
  await loadDashboard();
  showToast("Token pelajaran berhasil disimpan.");
}

async function generateRoomTokens() {
  const button = $("#generate-tokens-button");
  if (!state.rooms.length) throw new Error("No rooms are available to update.");
  if (!window.confirm(`Generate new access tokens for all ${state.rooms.length} rooms? Existing tokens will stop working.`)) return;
  button.disabled = true;
  try {
    const usedTokens = new Set([
      ...state.rooms.map((room) => room.active_token),
      ...state.sessions.map((session) => session.participant_token)
    ].filter(Boolean));
    const updates = state.rooms.map((room) => {
      let token = randomToken();
      while (usedTokens.has(token)) token = randomToken();
      usedTokens.add(token);
      return { room, token };
    });
    for (const { room, token } of updates) {
      const { error } = await state.client.from("rooms").update({ active_token: token }).eq("id", room.id);
      if (error) throw error;
    }
    await loadDashboard();
    showToast("Room tokens regenerated.");
  } finally {
    button.disabled = false;
  }
}

function showView(name) {
  $$(".view").forEach((view) => view.classList.toggle("hidden", view.id !== `view-${name}`));
  $$(".nav-item[data-view]").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
  const titles = { overview: "Ringkasan", students: "Siswa", rooms: "Ruang", sessions: "Pelajaran", monitor: "Monitor langsung" };
  $("#page-title").textContent = titles[name] || "Overview";
  if (name === "monitor" && $("#monitor-session").value) {
    loadMonitorLogs().catch((error) => showToast(errorMessage(error), true));
  }
}

function openSettings() {
  const config = getStoredConfig();
  $("#supabase-url").value = config?.url || "";
  $("#supabase-key").value = config?.key || "";
  $("#settings-account-email").value = state.user?.email || "";
  $("#password-form").reset();
  $("#admin-invite-form").reset();
  setSettingsError("");
  $("#password-error").textContent = "";
  $("#admin-error").textContent = "";
  $$(".settings-tab").forEach((tab) => {
    tab.classList.toggle("hidden", !state.user && tab.dataset.settingsTab !== "connection");
    tab.setAttribute("aria-selected", "false");
  });
  showSettingsTab(state.user ? "account" : "connection");
  $("#settings-dialog").showModal();
}

function showSettingsTab(name) {
  $$(".settings-tab").forEach((tab) => {
    const active = tab.dataset.settingsTab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  $$(".settings-panel").forEach((panel) => panel.classList.toggle("hidden", panel.id !== `settings-${name}`));
  if (name === "admins" && state.user) loadAdmins().catch((error) => setAdminError(errorMessage(error)));
}

async function saveSettings(event) {
  event.preventDefault();
  setSettingsError("");
  const url = $("#supabase-url").value.trim().replace(/\/+$/, "");
  const key = $("#supabase-key").value.trim();
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "localhost") {
      throw new Error("Use an HTTPS Supabase project URL.");
    }
    if (!key) throw new Error("Enter the Supabase anon/public key.");
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ url, key }));
    $("#settings-dialog").close();
    location.reload();
  } catch (error) {
    setSettingsError(errorMessage(error));
  }
}

function setAdminError(message = "") {
  $("#admin-error").textContent = message;
}

async function invokeAdminFunction(body) {
  const { data, error } = await state.client.functions.invoke("admin-management", { body });
  if (error) {
    const response = error.context;
    let detail;
    if (response && typeof response.json === "function") {
      try {
        detail = await response.json();
      } catch {}
    }
    if (detail?.error) throw new Error(detail.error);
    throw new Error(errorMessage(error));
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

async function loadAdmins() {
  const list = $("#admins-list");
  list.replaceChildren();
  const loading = document.createElement("div");
  loading.className = "empty-state";
  loading.textContent = "Memuat daftar admin…";
  list.append(loading);
  const { admins = [] } = await invokeAdminFunction({ action: "list" });
  list.replaceChildren();
  if (!admins.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Belum ada admin terdaftar.";
    list.append(empty);
    return;
  }
  const ownId = state.user?.id;
  for (const admin of admins) {
    const row = document.createElement("div");
    row.className = "admin-row";
    const identity = document.createElement("div");
    identity.className = "admin-identity";
    const email = document.createElement("strong");
    email.textContent = admin.email;
    const date = document.createElement("small");
    date.textContent = admin.user_id === ownId
      ? "Akun Anda"
      : `Admin sejak ${formatDate(admin.created_at, false)}`;
    identity.append(email, date);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "small-button";
    remove.textContent = "Cabut akses";
    remove.disabled = admin.user_id === ownId || admins.length === 1;
    remove.title = admin.user_id === ownId
      ? "Anda tidak dapat mencabut akses sendiri."
      : admins.length === 1
        ? "Admin terakhir tidak dapat dicabut."
        : "Cabut akses dashboard admin";
    remove.addEventListener("click", () => removeAdmin(admin).catch((error) => showToast(errorMessage(error), true)));
    row.append(identity, remove);
    list.append(row);
  }
}

async function inviteAdmin(event) {
  event.preventDefault();
  setAdminError("");
  const button = $("#invite-admin-button");
  button.disabled = true;
  try {
    const email = $("#admin-invite-email").value.trim();
    const result = await invokeAdminFunction({ action: "invite", email });
    $("#admin-invite-form").reset();
    showToast(result.invited
      ? `Undangan admin dikirim ke ${email}.`
      : `Akses admin diberikan kepada ${email}.`);
    await loadAdmins();
  } catch (error) {
    setAdminError(errorMessage(error));
  } finally {
    button.disabled = false;
  }
}

async function removeAdmin(admin) {
  if (!window.confirm(`Cabut akses dashboard admin untuk ${admin.email}? Akun Auth dan data tidak akan dihapus.`)) return;
  await invokeAdminFunction({ action: "remove", user_id: admin.user_id });
  showToast(`Akses admin ${admin.email} dicabut.`);
  await loadAdmins();
}

async function updateAdminPassword(event) {
  event.preventDefault();
  $("#password-error").textContent = "";
  const currentPassword = $("#current-password").value;
  const newPassword = $("#new-password").value;
  const confirmation = $("#confirm-password").value;
  if (newPassword.length < 8) {
    $("#password-error").textContent = "Sandi baru minimal 8 karakter.";
    return;
  }
  if (newPassword !== confirmation) {
    $("#password-error").textContent = "Konfirmasi sandi baru tidak cocok.";
    return;
  }
  const button = $("#password-form button[type=submit]");
  button.disabled = true;
  try {
    const email = state.user?.email;
    if (!email) throw new Error("Email akun tidak tersedia.");
    const { error: reauthError } = await state.client.auth.signInWithPassword({ email, password: currentPassword });
    if (reauthError) throw new Error("Sandi saat ini tidak benar.");
    const { error } = await state.client.auth.updateUser({ password: newPassword });
    if (error) throw error;
    $("#password-form").reset();
    showToast("Sandi admin berhasil diperbarui.");
  } catch (error) {
    $("#password-error").textContent = errorMessage(error);
  } finally {
    button.disabled = false;
  }
}

async function signOut() {
  if (!state.client) return;
  const { error } = await state.client.auth.signOut();
  if (error) showToast(errorMessage(error), true);
}

function bindEvents() {
  $$(".nav-item[data-view]").forEach((item) => item.addEventListener("click", () => showView(item.dataset.view)));
  $$("[data-go]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.go)));
  $("#student-search").addEventListener("input", renderStudents);
  $("#open-student-form-button").addEventListener("click", () => openStudentForm());
  $("#close-student-form-button").addEventListener("click", () => $("#student-form-wrap").classList.add("hidden"));
  $("#cancel-student-form-button").addEventListener("click", () => $("#student-form-wrap").classList.add("hidden"));
  $("#student-form").addEventListener("submit", saveStudent);
  $("#download-student-template-button").addEventListener("click", downloadStudentTemplate);
  $("#import-students-button").addEventListener("click", () => $("#student-file").click());
  $("#student-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await importStudentFile(file);
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      event.target.value = "";
    }
  });
  $("#open-room-form-button").addEventListener("click", () => openRoomForm());
  $("#cancel-room-form-button").addEventListener("click", () => $("#room-form-wrap").classList.add("hidden"));
  $("#cancel-room-form-button-2").addEventListener("click", () => $("#room-form-wrap").classList.add("hidden"));
  $("#room-form").addEventListener("submit", (event) => createRoom(event).catch((error) => showToast(errorMessage(error), true)));
  $("#generate-tokens-button").addEventListener("click", () => generateRoomTokens().catch((error) => showToast(errorMessage(error), true)));
  $("#mapping-session").addEventListener("change", () => loadRoomMapping().catch((error) => showToast(errorMessage(error), true)));
  $("#mapping-room").addEventListener("change", () => renderRoomMapping());
  $("#export-roster-button").addEventListener("click", exportRoomRoster);
  $("#new-session-button").addEventListener("click", () => openSessionForm());
  $("#cancel-session-button").addEventListener("click", () => $("#session-form-wrap").classList.add("hidden"));
  $("#cancel-session-button-2").addEventListener("click", () => $("#session-form-wrap").classList.add("hidden"));
  $("#session-form").addEventListener("submit", createSession);
  $("#monitor-session").addEventListener("change", () => loadMonitorLogs().catch((error) => showToast(errorMessage(error), true)));
  $("#monitor-room").addEventListener("change", renderMonitor);
  $("#refresh-monitor-button").addEventListener("click", () => loadMonitorLogs().catch((error) => showToast(errorMessage(error), true)));
  $("#settings-button").addEventListener("click", openSettings);
  $("#top-settings-button").addEventListener("click", openSettings);
  $("#top-sign-out-button").addEventListener("click", signOut);
  $("#open-settings-login").addEventListener("click", openSettings);
  $$(".settings-tab").forEach((tab) => tab.addEventListener("click", () => showSettingsTab(tab.dataset.settingsTab)));
  $("#password-form").addEventListener("submit", updateAdminPassword);
  $("#admin-invite-form").addEventListener("submit", inviteAdmin);
  $("#workspace-settings-form").addEventListener("submit", saveWorkspaceSettings);
  $("#refresh-admins-button").addEventListener("click", () => loadAdmins().catch((error) => setAdminError(errorMessage(error))));
  $("#close-settings-button").addEventListener("click", () => $("#settings-dialog").close());
  $("#cancel-settings-button").addEventListener("click", () => $("#settings-dialog").close());
  $("#settings-form").addEventListener("submit", saveSettings);
  $("#auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setAuthError("");
    if (!state.client) {
      setAuthError("Configure your Supabase project before signing in.");
      return;
    }
    const { error } = await state.client.auth.signInWithPassword({
      email: $("#auth-email").value.trim(),
      password: $("#auth-password").value
    });
    if (error) setAuthError(error.message);
  });
  $("#sign-out-button").addEventListener("click", signOut);
}

async function initialize() {
  bindEvents();
  const config = getStoredConfig();
  if (!config) {
    setApplicationVisible(false);
    openSettings();
    return;
  }
  try {
    await connectSupabase(config);
  } catch (error) {
    setAuthError(errorMessage(error));
    setApplicationVisible(false);
  }
}

initialize();
