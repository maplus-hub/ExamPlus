package com.examplus.participant

import android.app.Activity
import android.app.AlertDialog
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.BitmapFactory
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private var supabaseUrl = ""
    private var anonKey = ""
    private var nis = ""
    private var participantToken = ""
    private var sessionId = ""
    private var webView: WebView? = null
    private var inExam = false
    private var violationPaused = false
    private var screenReceiverRegistered = false
    private var resumeReceiverRegistered = false
    private var awaitingOverlaySettings = false
    private var pendingJoin: PendingJoin? = null
    private var lastFocusLossAt = 0L

    private val screenOffReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == Intent.ACTION_SCREEN_OFF && inExam) triggerViolation()
        }
    }

    private val proctorResumeReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val response = intent.getStringExtra(ViolationAlarmService.EXTRA_RESUME_RESPONSE)
                ?.let { runCatching { JSONObject(it) }.getOrNull() }
                ?: return
            completeProctorResume(response)
        }
    }

    private val heartbeat = object : Runnable {
        override fun run() {
            if (inExam && !violationPaused) {
                sendEvent("heartbeat")
                handler.postDelayed(this, HEARTBEAT_INTERVAL_MS)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        try {
            loadSharedConfig()
            registerReceivers()
            showJoinScreen()
        } catch (error: Exception) {
            showConfigurationErrorScreen(error.message ?: "Konfigurasi Supabase tidak dapat dibaca.")
        }
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        triggerViolation()
    }

    override fun onResume() {
        super.onResume()
        if (awaitingOverlaySettings) {
            awaitingOverlaySettings = false
            pendingJoin?.let { pending ->
                if (Settings.canDrawOverlays(this)) {
                    pendingJoin = null
                    performJoin(pending.layout, pending.nis, pending.token)
                } else {
                    pendingJoin = null
                    showJoinScreen("Izin tampil di atas aplikasi lain diperlukan untuk mengikuti ujian.")
                }
            }
        }
        pendingJoin?.let { pending ->
            if (Settings.canDrawOverlays(this)) {
                pendingJoin = null
                performJoin(pending.layout, pending.nis, pending.token)
            }
        }
        if (violationPaused) webView?.onPause() else webView?.onResume()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyImmersiveMode()
    }

    @Deprecated("Back navigation is intentionally restricted while an exam is open.")
    override fun onBackPressed() {
        if (violationPaused) {
            Toast.makeText(this, "Masukkan kode pengawas untuk melanjutkan ujian.", Toast.LENGTH_SHORT).show()
        } else if (inExam) {
            triggerViolation()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        if (screenReceiverRegistered) {
            unregisterReceiver(screenOffReceiver)
            screenReceiverRegistered = false
        }
        if (resumeReceiverRegistered) {
            unregisterReceiver(proctorResumeReceiver)
            resumeReceiverRegistered = false
        }
        webView?.destroy()
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
        if (key.isBlank() || key.contains("YOUR_SUPABASE")) {
            throw IllegalStateException("Isi anonKey pada config/supabase.json lalu bangun ulang APK.")
        }
        if (isServiceRoleKey(key)) {
            throw IllegalStateException("Gunakan anon/public key di config/supabase.json, bukan service_role.")
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

    private fun showConfigurationErrorScreen(detail: String) {
        val layout = createPage("Konfigurasi belum siap", "Koneksi Supabase dipakai bersama seluruh aplikasi ExamPlus.")
        layout.addView(messageText(detail, ERROR))
        layout.addView(messageText(
            "Perbarui config/supabase.json di folder proyek, lalu bangun ulang dan pasang APK.",
            MUTED
        ))
        setContentView(pageScroll(layout))
    }

    private fun showJoinScreen(error: String? = null) {
        inExam = false
        webView = null
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(28), dp(22), dp(28))
            setBackgroundColor(PAGE)
        }

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
        val heroCopy = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
        }
        heroCopy.addView(TextView(this).apply {
            text = "EXAMPLUS  ·  PORTAL PESERTA"
            textSize = 10f
            letterSpacing = 0.1f
            setTextColor(0xFFD8EEE4.toInt())
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        heroCopy.addView(TextView(this).apply {
            text = "Ujian dimulai dengan fokus."
            textSize = 21f
            setTextColor(Color.WHITE)
            setPadding(0, dp(9), 0, dp(6))
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        heroCopy.addView(TextView(this).apply {
            text = "Madrasah Aliyah Plus Sunan Giri · Salatiga"
            textSize = 11f
            setTextColor(0xFFD8EEE4.toInt())
        })
        hero.addView(heroCopy, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))

        val logoTile = FrameLayout(this).apply {
            background = roundedBackground(Color.WHITE, 0, 18f)
            setPadding(dp(5), dp(5), dp(5), dp(5))
        }
        val logo = assets.open(LOGO_ASSET).use { BitmapFactory.decodeStream(it) }
        logoTile.addView(ImageView(this).apply {
            setImageBitmap(logo)
            scaleType = ImageView.ScaleType.FIT_CENTER
            contentDescription = "Logo Madrasah Aliyah Plus Sunan Giri Salatiga"
        }, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))
        hero.addView(logoTile, LinearLayout.LayoutParams(dp(88), dp(88)).apply { leftMargin = dp(12) })
        content.addView(hero)

        val formCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(22), dp(22), dp(20))
            background = roundedBackground(Color.WHITE, 0xFFE2EAE5.toInt(), 22f)
            elevation = dp(4).toFloat()
        }
        formCard.addView(TextView(this).apply {
            text = "Masuk peserta"
            textSize = 23f
            setTextColor(INK)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        formCard.addView(TextView(this).apply {
            text = "Gunakan NIS dan token pelajaran dari admin."
            textSize = 13f
            setTextColor(MUTED)
            setPadding(0, dp(5), 0, dp(13))
        })
        val nisInput = input("NIS").apply {
            inputType = android.text.InputType.TYPE_CLASS_TEXT
            filters = arrayOf(android.text.InputFilter.LengthFilter(64))
            styleLoginInput()
        }
        val tokenInput = input("Token pelajaran 6 digit").apply {
            inputType = android.text.InputType.TYPE_CLASS_NUMBER
            filters = arrayOf(android.text.InputFilter.LengthFilter(6))
            styleLoginInput()
        }
        formCard.addView(TextView(this).apply {
            text = "NOMOR INDUK SISWA (NIS)"
            textSize = 10f
            letterSpacing = 0.07f
            setTextColor(INK)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            setPadding(0, dp(5), 0, dp(2))
        })
        formCard.addView(nisInput)
        formCard.addView(TextView(this).apply {
            text = "TOKEN PELAJARAN"
            textSize = 10f
            letterSpacing = 0.07f
            setTextColor(INK)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            setPadding(0, dp(7), 0, dp(2))
        })
        formCard.addView(tokenInput)
        if (!error.isNullOrBlank()) formCard.addView(messageText(error, ERROR))
        val joinButton = actionButton("Masuk dan mulai ujian") {
            val enteredNis = nisInput.text.toString().trim()
            val enteredToken = tokenInput.text.toString().trim()
            if (enteredNis.isBlank() || !enteredToken.matches(Regex("\\d{6}"))) {
                message("Masukkan NIS dan token pelajaran 6 digit yang valid.")
                return@actionButton
            }
            if (!Settings.canDrawOverlays(this)) {
                pendingJoin = PendingJoin(enteredNis, enteredToken, formCard)
                AlertDialog.Builder(this)
                    .setTitle("Izin tampilan overlay diperlukan")
                    .setMessage("Agar permintaan kode pengawas tetap terlihat di atas aplikasi lain saat ujian dijeda, izinkan ExamPlus tampil di atas aplikasi lain.")
                    .setNegativeButton("Batal") { _, _ -> pendingJoin = null }
                    .setPositiveButton("Buka pengaturan") { _, _ ->
                        awaitingOverlaySettings = true
                        startActivity(
                            Intent(
                                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                                Uri.parse("package:$packageName")
                            )
                        )
                    }
                    .show()
                return@actionButton
            }
            performJoin(formCard, enteredNis, enteredToken)
        }.apply {
            tag = JOIN_BUTTON_TAG
            text = "Masuk ke ujian  →"
            textSize = 15f
            minHeight = dp(54)
            background = roundedBackground(GREEN, 0, 14f)
            elevation = dp(2).toFloat()
        }
        formCard.addView(joinButton)
        formCard.addView(TextView(this).apply {
            text = "Koneksi sekolah siap digunakan"
            textSize = 11f
            gravity = Gravity.CENTER
            setTextColor(MUTED)
            setPadding(0, dp(14), 0, 0)
        })
        content.addView(formCard, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(16) })
        content.addView(TextView(this).apply {
            text = "Token ruang hanya digunakan saat keluar melalui pengawas."
            textSize = 11f
            gravity = Gravity.CENTER
            setTextColor(MUTED)
            setPadding(dp(8), dp(15), dp(8), 0)
        })
        val scroll = ScrollView(this).apply {
            setBackgroundColor(PAGE)
            isFillViewport = true
            addView(content)
        }
        setContentView(scroll)
    }

    private fun showExamScreen(response: JSONObject) {
        val session = response.getJSONObject("session")
        val participant = response.getJSONObject("participant")
        val formUrl = session.getString("gform_url")
        if (!isAllowedExamUrl(formUrl)) throw IllegalStateException("URL Google Forms tidak valid.")

        sessionId = session.getString("id")
        inExam = true
        violationPaused = false
        lastFocusLossAt = 0L
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(10), dp(16), dp(10))
            setBackgroundColor(SURFACE)
        }
        val identity = TextView(this).apply {
            text = "${participant.getString("name")} · ${participant.getString("room_name")} · Kursi ${participant.getInt("seat_number")}"
            textSize = 12f
            setTextColor(INK)
        }
        header.addView(identity, LinearLayout.LayoutParams(0, dp(44), 1f))
        header.addView(actionButton("Keluar", secondary = true) { requestRoomTokenExit() })
        val browser = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.setSupportMultipleWindows(false)
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    return !isAllowedExamUrl(request.url.toString())
                }
            }
            webChromeClient = WebChromeClient()
        }
        webView = browser
        root.addView(header)
        root.addView(browser, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            0,
            1f
        ))
        setContentView(root)
        applyImmersiveMode()
        runCatching { startLockTask() }
            .onFailure { Toast.makeText(this, "Mode kios tidak dapat diaktifkan.", Toast.LENGTH_LONG).show() }
        browser.loadUrl(formUrl)
        handler.removeCallbacks(heartbeat)
        handler.postDelayed(heartbeat, HEARTBEAT_INTERVAL_MS)
    }

    private fun requestRoomTokenExit() {
        val tokenInput = input("Token ruang 6 digit")
        tokenInput.inputType = android.text.InputType.TYPE_CLASS_NUMBER
        tokenInput.filters = arrayOf(android.text.InputFilter.LengthFilter(6))
        AlertDialog.Builder(this)
            .setTitle("Keluar dari ujian")
            .setMessage("Minta token ruang kepada pengawas untuk mengakhiri sesi di perangkat ini.")
            .setView(tokenInput)
            .setNegativeButton("Batal", null)
            .setPositiveButton("Verifikasi") { _, _ ->
                val token = tokenInput.text.toString().trim()
                if (!token.matches(Regex("\\d{6}"))) {
                    message("Token ruang harus terdiri dari 6 digit.")
                    return@setPositiveButton
                }
                sendRequest(
                    eventPayload("finish").put("room_token", token)
                ) { _, failure ->
                    if (failure != null) message(failure) else leaveExam()
                }
            }
            .show()
    }

    private fun sendEvent(action: String) {
        sendRequest(eventPayload(action)) { _, failure ->
            if (failure != null) {
                Toast.makeText(this, failure, Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun triggerViolation() {
        if (!inExam || violationPaused) return
        val now = System.currentTimeMillis()
        if (now - lastFocusLossAt < FOCUS_LOSS_DEBOUNCE_MS) return
        lastFocusLossAt = now
        violationPaused = true
        webView?.onPause()
        handler.removeCallbacks(heartbeat)
        startViolationAlarm()
    }

    private fun performJoin(layout: LinearLayout, enteredNis: String, enteredToken: String) {
        nis = enteredNis
        participantToken = enteredToken
        setLoading(layout, true)
        sendRequest(
            JSONObject()
                .put("action", "join")
                .put("nis", nis)
                .put("participant_token", participantToken)
        ) { response, failure ->
            setLoading(layout, false)
            if (failure != null) {
                if (response?.optBoolean("requires_proctor") == true) {
                    sessionId = response.getJSONObject("session").getString("id")
                    violationPaused = true
                    startViolationAlarm(response.optBoolean("alarm_active", true), recordViolation = false)
                    showJoinScreen(failure)
                } else {
                    showJoinScreen(failure)
                }
            } else {
                runCatching { showExamScreen(response ?: JSONObject()) }
                    .onFailure { showJoinScreen(it.message ?: "Respons server tidak valid.") }
            }
        }
    }

    private fun startViolationAlarm(alarmInitiallyActive: Boolean = true, recordViolation: Boolean = true) {
        val intent = Intent(this, ViolationAlarmService::class.java)
            .setAction(ViolationAlarmService.ACTION_START)
            .putExtra(ViolationAlarmService.EXTRA_SUPABASE_URL, supabaseUrl)
            .putExtra(ViolationAlarmService.EXTRA_ANON_KEY, anonKey)
            .putExtra(ViolationAlarmService.EXTRA_NIS, nis)
            .putExtra(ViolationAlarmService.EXTRA_PARTICIPANT_TOKEN, participantToken)
            .putExtra(ViolationAlarmService.EXTRA_SESSION_ID, sessionId)
            .putExtra(ViolationAlarmService.EXTRA_ALARM_ACTIVE, alarmInitiallyActive)
            .putExtra(ViolationAlarmService.EXTRA_RECORD_VIOLATION, recordViolation)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent) else startService(intent)
    }

    private fun completeProctorResume(response: JSONObject) {
        if (webView == null) {
            showExamScreen(response)
            return
        }
        violationPaused = false
        lastFocusLossAt = 0L
        webView?.onResume()
        applyImmersiveMode()
        handler.removeCallbacks(heartbeat)
        handler.postDelayed(heartbeat, HEARTBEAT_INTERVAL_MS)
    }

    private fun registerReceivers() {
        val screenFilter = IntentFilter(Intent.ACTION_SCREEN_OFF)
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(screenOffReceiver, screenFilter, Context.RECEIVER_NOT_EXPORTED)
            screenReceiverRegistered = true
            registerReceiver(proctorResumeReceiver, IntentFilter(ViolationAlarmService.ACTION_PROCTOR_RESUMED), Context.RECEIVER_NOT_EXPORTED)
            resumeReceiverRegistered = true
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(screenOffReceiver, screenFilter)
            screenReceiverRegistered = true
            @Suppress("DEPRECATION")
            registerReceiver(proctorResumeReceiver, IntentFilter(ViolationAlarmService.ACTION_PROCTOR_RESUMED))
            resumeReceiverRegistered = true
        }
    }

    private fun eventPayload(action: String) = JSONObject()
        .put("action", action)
        .put("nis", nis)
        .put("participant_token", participantToken)
        .put("session_id", sessionId)

    private fun leaveExam() {
        handler.removeCallbacks(heartbeat)
        stopService(Intent(this, ViolationAlarmService::class.java))
        inExam = false
        violationPaused = false
        runCatching { stopLockTask() }
        webView?.apply {
            stopLoading()
            clearHistory()
            clearCache(true)
            loadUrl("about:blank")
            destroy()
        }
        webView = null
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
        sessionId = ""
        nis = ""
        participantToken = ""
        showJoinScreen()
    }

    private fun sendRequest(payload: JSONObject, callback: (JSONObject?, String?) -> Unit) {
        executor.execute {
            var connection: HttpURLConnection? = null
            try {
                connection = (URL("$supabaseUrl/functions/v1/participant-access").openConnection() as HttpURLConnection).apply {
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
                val json = runCatching { JSONObject(body) }.getOrNull() ?: JSONObject()
                val failure = if (status in 200..299) null else json.optString("error").ifBlank { "Permintaan gagal (HTTP $status)." }
                runOnUiThread { callback(json, failure) }
            } catch (error: Exception) {
                runOnUiThread { callback(null, error.localizedMessage ?: "Tidak dapat menghubungi server.") }
            } finally {
                connection?.disconnect()
            }
        }
    }

    private fun isAllowedExamUrl(value: String): Boolean {
        val parsed = runCatching { URL(value) }.getOrNull() ?: return false
        val allowedHosts = setOf(
            "docs.google.com",
            "accounts.google.com",
            "accounts.google.co.id",
            "google.com",
            "www.google.com",
            "drive.google.com",
            "support.google.com"
        )
        return parsed.protocol == "https" && parsed.host.lowercase() in allowedHosts
    }

    private fun createPage(title: String, subtitle: String): LinearLayout {
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(28), dp(24), dp(24))
            setBackgroundColor(SURFACE)
        }
        layout.addView(TextView(this).apply {
            text = "EXAMPLUS"
            textSize = 12f
            setTextColor(INDIGO)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        layout.addView(TextView(this).apply {
            text = title
            textSize = 25f
            setTextColor(INK)
            setPadding(0, dp(18), 0, dp(4))
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        layout.addView(TextView(this).apply {
            text = subtitle
            textSize = 14f
            setTextColor(MUTED)
            setPadding(0, 0, 0, dp(20))
        })
        return layout
    }

    private fun pageScroll(content: View): ScrollView = ScrollView(this).apply {
        setBackgroundColor(SURFACE)
        isFillViewport = true
        addView(content)
    }

    private fun input(hintText: String): EditText = EditText(this).apply {
        hint = hintText
        textSize = 16f
        setSingleLine(true)
        setPadding(dp(14), dp(12), dp(14), dp(12))
        setTextColor(INK)
        setHintTextColor(MUTED)
        backgroundTintList = android.content.res.ColorStateList.valueOf(Color.LTGRAY)
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = dp(12) }
    }

    private fun actionButton(label: String, secondary: Boolean = false, action: () -> Unit): Button =
        Button(this).apply {
            text = label
            isAllCaps = false
            textSize = 14f
            setTextColor(if (secondary) INDIGO else Color.WHITE)
            setBackgroundColor(if (secondary) Color.WHITE else INDIGO)
            setPadding(dp(12), dp(8), dp(12), dp(8))
            setOnClickListener { action() }
        }

    private fun messageText(value: String, color: Int): TextView = TextView(this).apply {
        text = value
        textSize = 13f
        setTextColor(color)
        setPadding(0, 0, 0, dp(12))
    }

    private fun EditText.styleLoginInput() {
        minHeight = dp(54)
        setPadding(dp(15), dp(10), dp(15), dp(10))
        background = roundedBackground(Color.WHITE, 0xFFDCE7E1.toInt(), 14f)
        backgroundTintList = null
    }

    private fun roundedBackground(fillColor: Int, strokeColor: Int, radiusDp: Float): GradientDrawable =
        GradientDrawable().apply {
            setColor(fillColor)
            cornerRadius = dp(radiusDp.toInt()).toFloat()
            if (strokeColor != 0) setStroke(dp(1), strokeColor)
        }

    private fun message(value: String) =
        Toast.makeText(this, value, Toast.LENGTH_LONG).show()

    private fun setLoading(layout: LinearLayout, loading: Boolean) {
        for (index in 0 until layout.childCount) {
            val child = layout.getChildAt(index)
            if (child is Button && child.tag == JOIN_BUTTON_TAG) {
                child.isEnabled = !loading
                child.text = if (loading) "Memeriksa…" else "Masuk dan mulai ujian"
            }
        }
    }

    private data class PendingJoin(val nis: String, val token: String, val layout: LinearLayout)

    @Suppress("DEPRECATION")
    private fun applyImmersiveMode() {
        window.decorView.systemUiVisibility =
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        private const val CONFIG_ASSET = "supabase.json"
        private const val LOGO_ASSET = "school-logo.png"
        private const val JOIN_BUTTON_TAG = "join-button"
        private const val NETWORK_TIMEOUT_MS = 15_000
        private const val HEARTBEAT_INTERVAL_MS = 30_000L
        private const val FOCUS_LOSS_DEBOUNCE_MS = 10_000L
        private const val SURFACE = 0xFFF5F7FB.toInt()
        private const val INK = 0xFF17213A.toInt()
        private const val MUTED = 0xFF8290A8.toInt()
        private const val INDIGO = 0xFF5B65DF.toInt()
        private const val ERROR = 0xFFB54747.toInt()
        private const val PAGE = 0xFFF1F6F3.toInt()
        private const val GREEN = 0xFF11785F.toInt()
        private const val GREEN_DARK = 0xFF07503F.toInt()
    }
}
