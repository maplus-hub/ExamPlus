package com.examplus.proctor

import android.app.Activity
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private var supabaseUrl = ""
    private var anonKey = ""
    private var roomName = ""
    private var proctorCode = ""
    private var selectedSessionId = ""
    private var selectedSessionTitle = ""
    private var availableSessions = JSONArray()
    private var isRefreshing = false

    private val refreshRosterTask = object : Runnable {
        override fun run() {
            if (selectedSessionId.isNotBlank()) {
                refreshRoster(silent = true)
                handler.postDelayed(this, REFRESH_INTERVAL_MS)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        try {
            loadSharedConfig()
            showLogin()
        } catch (error: Exception) {
            showMessageScreen("Konfigurasi belum siap", error.message ?: "Konfigurasi Supabase tidak dapat dibaca.")
        }
    }

    override fun onResume() {
        super.onResume()
        if (selectedSessionId.isNotBlank()) scheduleRosterRefresh()
    }

    override fun onPause() {
        handler.removeCallbacks(refreshRosterTask)
        super.onPause()
    }

    override fun onBackPressed() {
        if (selectedSessionId.isNotBlank()) {
            selectedSessionId = ""
            showSessionPicker()
        } else if (roomName.isNotBlank()) {
            logout()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        executor.shutdown()
        super.onDestroy()
    }

    private fun loadSharedConfig() {
        val config = assets.open(CONFIG_ASSET).bufferedReader().use { JSONObject(it.readText()) }
        val url = config.optString("url").trim().trimEnd('/')
        val key = config.optString("anonKey").trim()
        val parsed = runCatching { URL(url) }.getOrNull()
        if (parsed?.protocol != "https" || parsed.host.isNullOrBlank() ||
            parsed.host.contains("your_project_id", ignoreCase = true) ||
            !parsed.userInfo.isNullOrBlank() || parsed.path.isNotEmpty() ||
            !parsed.query.isNullOrBlank() || !parsed.ref.isNullOrBlank()
        ) {
            throw IllegalStateException("URL project di config/supabase.json tidak valid.")
        }
        if (key.isBlank() || key.contains("YOUR_SUPABASE") || isServiceRoleKey(key)) {
            throw IllegalStateException("Isi anonKey publik pada config/supabase.json; jangan gunakan service_role.")
        }
        supabaseUrl = url
        anonKey = key
    }

    private fun isServiceRoleKey(key: String): Boolean {
        val payload = key.split(".").getOrNull(1) ?: return false
        return runCatching {
            val decoded = Base64.decode(payload, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
            JSONObject(String(decoded, Charsets.UTF_8)).optString("role") == "service_role"
        }.getOrDefault(false)
    }

    private fun showLogin(error: String? = null) {
        val root = newRoot()
        root.addView(brandHero())
        val card = newCard()
        card.addView(text("Masuk pengawas", 24f, INK, true))
        card.addView(text("Pilih ruang dengan nama ruang dan kode rahasia pengawas.", 13f, MUTED).apply {
            setPadding(0, dp(5), 0, dp(12))
        })
        val roomInput = input("Nama ruang")
        val codeInput = input("Kode rahasia pengawas").apply {
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        card.addView(label("NAMA RUANG"))
        card.addView(roomInput)
        card.addView(label("KODE PENGAWAS"))
        card.addView(codeInput)
        val errorText = text(error.orEmpty(), 12f, ERROR).apply { minHeight = dp(20) }
        card.addView(errorText)
        val loginButton = button("Masuk ke panel") {
            val enteredRoom = roomInput.text.toString().trim()
            val enteredCode = codeInput.text.toString().trim()
            if (enteredRoom.isBlank() || enteredCode.length < MIN_PROCTOR_CODE_LENGTH) {
                errorText.text = "Masukkan nama ruang dan kode pengawas minimal 8 karakter."
                return@button
            }
            roomName = enteredRoom
            proctorCode = enteredCode
            setButtonBusy(it, busy = true, busyText = "Memverifikasi…", readyText = "Masuk ke panel")
            apiRequest(JSONObject().put("action", "login").put("room_name", enteredRoom).put("proctor_code", enteredCode)) { response, failure ->
                setButtonBusy(it, false, "Memverifikasi…", "Masuk ke panel")
                if (failure != null || response == null) {
                    roomName = ""
                    proctorCode = ""
                    errorText.text = failure ?: "Respons server tidak valid."
                    return@apiRequest
                }
                val room = response.optJSONObject("room") ?: JSONObject()
                roomName = room.optString("room_name", enteredRoom)
                showSessionPicker(response.optJSONArray("sessions") ?: JSONArray())
            }
        }
        card.addView(loginButton)
        card.addView(text("Kode pengawas hanya disimpan sementara di memori aplikasi.", 11f, MUTED).apply {
            gravity = Gravity.CENTER
            setPadding(0, dp(14), 0, 0)
        })
        root.addView(card, marginTop(dp(16)))
        setPage(root)
    }

    private fun showSessionPicker(sessions: JSONArray? = null) {
        if (sessions != null) availableSessions = sessions
        val root = newRoot()
        root.addView(topBar("Pilih pelajaran", "Ruang $roomName"))
        val card = newCard()
        card.addView(text("Pelajaran aktif", 22f, INK, true))
        card.addView(text("Pilih pelajaran untuk membuka daftar peserta di ruang ini.", 13f, MUTED).apply {
            setPadding(0, dp(5), 0, dp(12))
        })
        if (availableSessions.length() == 0) {
            card.addView(text("Belum ada pelajaran aktif untuk ruang ini.", 14f, MUTED).apply {
                gravity = Gravity.CENTER
                setPadding(dp(10), dp(28), dp(10), dp(28))
            })
        } else {
            for (index in 0 until availableSessions.length()) {
                val session = availableSessions.optJSONObject(index) ?: continue
                val sessionId = session.optString("id")
                val sessionTitle = session.optString("title", "Pelajaran")
                val item = button("$sessionTitle\n${dateRange(session)}") {
                    selectedSessionId = sessionId
                    selectedSessionTitle = sessionTitle
                    refreshRoster(silent = false)
                }
                item.gravity = Gravity.START or Gravity.CENTER_VERTICAL
                item.textSize = 14f
                item.setPadding(dp(16), dp(13), dp(16), dp(13))
                item.background = roundedBackground(WHITE, LINE, 14f)
                item.setTextColor(INK)
                card.addView(item, marginTop(dp(9)))
            }
        }
        val actions = horizontalRow()
        actions.addView(button("Muat ulang") { refreshSessions() }, weightedLayout())
        actions.addView(button("Keluar") { logout() }, weightedLayout().apply { leftMargin = dp(8) })
        card.addView(actions, marginTop(dp(14)))
        root.addView(card, marginTop(dp(16)))
        setPage(root)
    }

    private fun refreshSessions() {
        apiRequest(JSONObject().put("action", "login").put("room_name", roomName).put("proctor_code", proctorCode)) { response, failure ->
            if (failure != null || response == null) {
                toast(failure ?: "Gagal memuat pelajaran.")
            } else {
                showSessionPicker(response.optJSONArray("sessions") ?: JSONArray())
            }
        }
    }

    private fun refreshRoster(silent: Boolean) {
        if (isRefreshing || selectedSessionId.isBlank()) return
        isRefreshing = true
        apiRequest(
            JSONObject()
                .put("action", "roster")
                .put("room_name", roomName)
                .put("proctor_code", proctorCode)
                .put("session_id", selectedSessionId)
        ) { response, failure ->
            isRefreshing = false
            if (selectedSessionId.isBlank()) return@apiRequest
            if (failure != null || response == null) {
                if (!silent) toast(failure ?: "Gagal memuat daftar peserta.")
            } else {
                showRoster(response.optJSONObject("session") ?: JSONObject(), response.optJSONArray("roster") ?: JSONArray())
            }
        }
    }

    private fun showRoster(session: JSONObject, roster: JSONArray) {
        val root = newRoot()
        val bar = topBar("Pemantauan ruang", roomName)
        val headerButtons = horizontalRow()
        headerButtons.addView(button("Pelajaran") {
            selectedSessionId = ""
            handler.removeCallbacks(refreshRosterTask)
            showSessionPicker()
        }, weightedLayout())
        headerButtons.addView(button("Keluar") { logout() }, weightedLayout().apply { leftMargin = dp(8) })
        bar.addView(headerButtons, marginTop(dp(12)))
        root.addView(bar)

        val summaryCard = newCard()
        summaryCard.addView(text(selectedSessionTitle.ifBlank { session.optString("title", "Pelajaran") }, 19f, INK, true))
        val blockedCount = (0 until roster.length()).count { roster.optJSONObject(it)?.optString("status") == "blocked" }
        val alarmCount = (0 until roster.length()).count { roster.optJSONObject(it)?.optBoolean("alarm_active") == true }
        summaryCard.addView(text("${roster.length()} peserta  ·  $blockedCount diblokir  ·  $alarmCount alarm aktif", 12f, MUTED).apply {
            setPadding(0, dp(5), 0, dp(10))
        })
        val refresh = button("Segarkan daftar") { refreshRoster(silent = false) }
        summaryCard.addView(refresh)
        root.addView(summaryCard, marginTop(dp(12)))

        if (roster.length() == 0) {
            val empty = newCard()
            empty.addView(text("Belum ada peserta pada pelajaran ini.", 14f, MUTED).apply { gravity = Gravity.CENTER })
            root.addView(empty, marginTop(dp(10)))
        }
        for (index in 0 until roster.length()) {
            val participant = roster.optJSONObject(index) ?: continue
            root.addView(participantCard(participant), marginTop(dp(10)))
        }
        setPage(root)
        scheduleRosterRefresh()
    }

    private fun participantCard(participant: JSONObject): LinearLayout {
        val card = newCard()
        val top = horizontalRow()
        val identity = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        identity.addView(text(participant.optString("name"), 16f, INK, true))
        identity.addView(text(
            "NIS ${participant.optString("nis")}  ·  ${participant.optString("original_class")}",
            11f,
            MUTED
        ).apply { setPadding(0, dp(3), 0, 0) })
        top.addView(identity, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        top.addView(statusBadge(participant.optString("status")))
        card.addView(top)
        card.addView(text(
            "Ruang $roomName  ·  Kursi ${participant.optInt("seat_number")}  ·  Pelanggaran ${participant.optInt("violation_count")}",
            12f,
            MUTED
        ).apply { setPadding(0, dp(9), 0, dp(2)) })
        val lastHeartbeat = participant.optString("last_heartbeat")
        card.addView(text(
            if (lastHeartbeat.isBlank() || lastHeartbeat == "null") "Belum terhubung" else "Terakhir aktif: ${lastHeartbeat.replace("T", " ").take(16)}",
            11f,
            MUTED
        ))

        val logId = participant.optString("log_id")
        val actions = horizontalRow()
        if (participant.optBoolean("alarm_active") && logId.isNotBlank() && logId != "null") {
            actions.addView(button("Matikan alarm") {
                runProctorAction("mute_alarm", logId)
            }, weightedLayout())
        }
        if (participant.optString("status") == "blocked" && logId.isNotBlank() && logId != "null") {
            actions.addView(button("Izinkan lanjut") {
                runProctorAction("resume_participant", logId)
            }, weightedLayout().apply {
                if (actions.childCount > 0) leftMargin = dp(8)
            })
        }
        if (actions.childCount > 0) card.addView(actions, marginTop(dp(12)))
        return card
    }

    private fun runProctorAction(action: String, logId: String) {
        apiRequest(
            JSONObject()
                .put("action", action)
                .put("room_name", roomName)
                .put("proctor_code", proctorCode)
                .put("session_id", selectedSessionId)
                .put("log_id", logId)
        ) { _, failure ->
            if (failure != null) toast(failure)
            else {
                toast(if (action == "mute_alarm") "Alarm dimatikan." else "Peserta diizinkan melanjutkan ujian.")
                refreshRoster(silent = true)
            }
        }
    }

    private fun statusBadge(status: String): TextView {
        val label = when (status) {
            "blocked" -> "Perlu pengawas"
            "in_exam" -> "Sedang ujian"
            "logged_in" -> "Sudah masuk"
            "finished" -> "Selesai"
            else -> "Belum masuk"
        }
        val backgroundColor = when (status) {
            "blocked" -> 0xFFFFE6E2.toInt()
            "in_exam" -> 0xFFDFF2E9.toInt()
            "finished" -> 0xFFE9EDF2.toInt()
            else -> 0xFFFFF1D9.toInt()
        }
        val textColor = when (status) {
            "blocked" -> 0xFFAA3E35.toInt()
            "in_exam" -> 0xFF167451.toInt()
            "finished" -> 0xFF617080.toInt()
            else -> 0xFF8A6323.toInt()
        }
        return text(label, 10f, textColor, true).apply {
            setPadding(dp(9), dp(6), dp(9), dp(6))
            background = roundedBackground(backgroundColor, 0, 30f)
        }
    }

    private fun logout() {
        handler.removeCallbacks(refreshRosterTask)
        roomName = ""
        proctorCode = ""
        selectedSessionId = ""
        selectedSessionTitle = ""
        availableSessions = JSONArray()
        showLogin()
    }

    private fun scheduleRosterRefresh() {
        handler.removeCallbacks(refreshRosterTask)
        if (selectedSessionId.isNotBlank()) handler.postDelayed(refreshRosterTask, REFRESH_INTERVAL_MS)
    }

    private fun apiRequest(payload: JSONObject, callback: (JSONObject?, String?) -> Unit) {
        executor.execute {
            var connection: HttpURLConnection? = null
            try {
                connection = (URL("$supabaseUrl/functions/v1/proctor-access").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = NETWORK_TIMEOUT_MS
                    readTimeout = NETWORK_TIMEOUT_MS
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                    setRequestProperty("apikey", anonKey)
                    setRequestProperty("Authorization", "Bearer $anonKey")
                }
                connection.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
                val status = connection.responseCode
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
                val response = runCatching { JSONObject(body) }.getOrNull() ?: JSONObject()
                val failure = if (status in 200..299) null else
                    response.optString("error").ifBlank { "Permintaan gagal (HTTP $status)." }
                handler.post { callback(response, failure) }
            } catch (error: Exception) {
                handler.post { callback(null, error.localizedMessage ?: "Tidak dapat menghubungi server.") }
            } finally {
                connection?.disconnect()
            }
        }
    }

    private fun brandHero(): LinearLayout {
        val hero = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(18), dp(20), dp(18), dp(20))
            background = GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                intArrayOf(GREEN_DARK, GREEN)
            ).apply { cornerRadius = dp(24).toFloat() }
            elevation = dp(5).toFloat()
        }
        val copy = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        copy.addView(text("EXAMPLUS  ·  APLIKASI PENGAWAS", 10f, 0xFFD8EEE4.toInt(), true))
        copy.addView(text("Pantau ujian, bantu peserta.", 21f, Color.WHITE, true).apply {
            setPadding(0, dp(9), 0, dp(6))
        })
        copy.addView(text("Madrasah Aliyah Plus Sunan Giri · Salatiga", 11f, 0xFFD8EEE4.toInt()))
        hero.addView(copy, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        val logoFrame = FrameLayout(this).apply {
            background = roundedBackground(Color.WHITE, 0, 18f)
            setPadding(dp(5), dp(5), dp(5), dp(5))
        }
        val bitmap = assets.open(LOGO_ASSET).use { BitmapFactory.decodeStream(it) }
        logoFrame.addView(ImageView(this).apply {
            setImageBitmap(bitmap)
            scaleType = ImageView.ScaleType.FIT_CENTER
            contentDescription = "Logo ExamPlus"
        }, FrameLayout.LayoutParams(dp(78), dp(78)))
        hero.addView(logoFrame, LinearLayout.LayoutParams(dp(88), dp(88)).apply { leftMargin = dp(10) })
        return hero
    }

    private fun topBar(title: String, subtitle: String) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(2), dp(3), dp(2), dp(4))
        addView(text(title, 24f, INK, true))
        addView(text(subtitle, 13f, MUTED).apply { setPadding(0, dp(3), 0, 0) })
    }

    private fun newRoot() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(20), dp(26), dp(20), dp(26))
        setBackgroundColor(PAGE)
    }

    private fun newCard() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(19), dp(18), dp(19), dp(18))
        background = roundedBackground(WHITE, LINE, 20f)
        elevation = dp(2).toFloat()
    }

    private fun setPage(root: LinearLayout) {
        setContentView(ScrollView(this).apply {
            setBackgroundColor(PAGE)
            isFillViewport = true
            addView(root)
        })
    }

    private fun input(hintText: String) = EditText(this).apply {
        hint = hintText
        textSize = 15f
        setSingleLine(true)
        setPadding(dp(14), dp(12), dp(14), dp(12))
        minHeight = dp(52)
        setTextColor(INK)
        setHintTextColor(MUTED)
        background = roundedBackground(WHITE, LINE, 13f)
        backgroundTintList = null
    }

    private fun label(value: String) = text(value, 10f, INK, true).apply {
        letterSpacing = 0.08f
        setPadding(0, dp(7), 0, dp(3))
    }

    private fun text(value: String, size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(color)
        if (bold) setTypeface(typeface, Typeface.BOLD)
    }

    private fun button(value: String, onClick: (Button) -> Unit) = Button(this).apply {
        text = value
        isAllCaps = false
        textSize = 13f
        setTextColor(if (value == "Keluar") GREEN else Color.WHITE)
        minHeight = dp(44)
        setPadding(dp(11), dp(8), dp(11), dp(8))
        background = roundedBackground(if (value == "Keluar") WHITE else GREEN, if (value == "Keluar") LINE else 0, 12f)
        setOnClickListener { onClick(this) }
    }

    private fun setButtonBusy(button: Button, busy: Boolean, busyText: String, readyText: String) {
        button.isEnabled = !busy
        button.text = if (busy) busyText else readyText
    }

    private fun roundedBackground(fillColor: Int, strokeColor: Int, radiusDp: Float) =
        GradientDrawable().apply {
            setColor(fillColor)
            cornerRadius = dp(radiusDp.toInt()).toFloat()
            if (strokeColor != 0) setStroke(dp(1), strokeColor)
        }

    private fun horizontalRow() = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
    }

    private fun marginTop(top: Int) = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
    ).apply { topMargin = top }

    private fun weightedLayout() = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)

    private fun dateRange(session: JSONObject): String =
        "${session.optString("start_time").replace("T", " ").take(16)} – ${session.optString("end_time").replace("T", " ").take(16)}"

    private fun showMessageScreen(title: String, detail: String) {
        val root = newRoot()
        root.addView(brandHero())
        val card = newCard()
        card.addView(text(title, 22f, INK, true))
        card.addView(text(detail, 13f, MUTED).apply { setPadding(0, dp(6), 0, 0) })
        root.addView(card, marginTop(dp(16)))
        setPage(root)
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        private const val CONFIG_ASSET = "supabase.json"
        private const val LOGO_ASSET = "school-logo.png"
        private const val NETWORK_TIMEOUT_MS = 15_000
        private const val MIN_PROCTOR_CODE_LENGTH = 8
        private const val REFRESH_INTERVAL_MS = 15_000L
        private const val PAGE = 0xFFF1F6F3.toInt()
        private const val WHITE = 0xFFFFFFFF.toInt()
        private const val LINE = 0xFFE1EBE6.toInt()
        private const val INK = 0xFF17352D.toInt()
        private const val MUTED = 0xFF70827B.toInt()
        private const val GREEN = 0xFF11785F.toInt()
        private const val GREEN_DARK = 0xFF07503F.toInt()
        private const val ERROR = 0xFFB54747.toInt()
    }
}
