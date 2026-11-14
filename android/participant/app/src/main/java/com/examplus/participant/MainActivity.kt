package com.examplus.participant

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
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
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val preferences by lazy { getSharedPreferences("examplus-participant", MODE_PRIVATE) }
    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private var nis = ""
    private var participantToken = ""
    private var sessionId = ""
    private var webView: WebView? = null
    private var inExam = false
    private var lastFocusLossAt = 0L

    private val heartbeat = object : Runnable {
        override fun run() {
            if (inExam) {
                sendEvent("heartbeat")
                handler.postDelayed(this, HEARTBEAT_INTERVAL_MS)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        if (configured()) showJoinScreen() else showConfigurationScreen()
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (!inExam) return
        val now = System.currentTimeMillis()
        if (now - lastFocusLossAt < FOCUS_LOSS_DEBOUNCE_MS) return
        lastFocusLossAt = now
        sendEvent("focus_loss")
        Toast.makeText(this, "Jangan keluar dari aplikasi ujian.", Toast.LENGTH_SHORT).show()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyImmersiveMode()
    }

    @Deprecated("Back navigation is intentionally restricted while an exam is open.")
    override fun onBackPressed() {
        if (inExam) {
            Toast.makeText(this, "Minta bantuan pengawas untuk keluar dari ujian.", Toast.LENGTH_SHORT).show()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        webView?.destroy()
        executor.shutdown()
        super.onDestroy()
    }

    private fun configured(): Boolean =
        !preferences.getString(KEY_PROJECT_URL, null).isNullOrBlank() &&
            !preferences.getString(KEY_ANON_KEY, null).isNullOrBlank()

    private fun showConfigurationScreen() {
        val layout = createPage("Pengaturan aplikasi", "Hubungkan aplikasi ke project Supabase sekolah.")
        val urlInput = input("Project URL, contoh https://project.supabase.co").apply {
            setText(preferences.getString(KEY_PROJECT_URL, ""))
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
        }
        val keyInput = input("Anon/public key").apply {
            setText(preferences.getString(KEY_ANON_KEY, ""))
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        layout.addView(urlInput)
        layout.addView(keyInput)
        layout.addView(actionButton("Simpan pengaturan") {
            val projectUrl = urlInput.text.toString().trim().trimEnd('/')
            val anonKey = keyInput.text.toString().trim()
            val parsed = runCatching { URL(projectUrl) }.getOrNull()
            if (parsed?.protocol != "https" || anonKey.isBlank()) {
                message("Masukkan URL HTTPS project dan anon/public key.")
                return@actionButton
            }
            preferences.edit()
                .putString(KEY_PROJECT_URL, projectUrl)
                .putString(KEY_ANON_KEY, anonKey)
                .apply()
            showJoinScreen()
        })
        setContentView(pageScroll(layout))
    }

    private fun showJoinScreen(error: String? = null) {
        inExam = false
        webView = null
        val layout = createPage("Masuk ujian", "Masukkan NIS dan token pelajaran dari admin.")
        val nisInput = input("NIS").apply {
            inputType = android.text.InputType.TYPE_CLASS_TEXT
            filters = arrayOf(android.text.InputFilter.LengthFilter(64))
        }
        val tokenInput = input("Token pelajaran 6 digit").apply {
            inputType = android.text.InputType.TYPE_CLASS_NUMBER
            filters = arrayOf(android.text.InputFilter.LengthFilter(6))
        }
        layout.addView(nisInput)
        layout.addView(tokenInput)
        if (!error.isNullOrBlank()) layout.addView(messageText(error, ERROR))
        val joinButton = actionButton("Masuk dan mulai ujian") {
            val enteredNis = nisInput.text.toString().trim()
            val enteredToken = tokenInput.text.toString().trim()
            if (enteredNis.isBlank() || !enteredToken.matches(Regex("\\d{6}"))) {
                message("Masukkan NIS dan token pelajaran 6 digit yang valid.")
                return@actionButton
            }
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
                    showJoinScreen(failure)
                } else {
                    runCatching { showExamScreen(response ?: JSONObject()) }
                        .onFailure { showJoinScreen(it.message ?: "Respons server tidak valid.") }
                }
            }
        }.apply { tag = JOIN_BUTTON_TAG }
        layout.addView(joinButton)
        layout.addView(actionButton("Pengaturan koneksi", secondary = true) { showConfigurationDialog() })
        setContentView(pageScroll(layout))
    }

    private fun showExamScreen(response: JSONObject) {
        val session = response.getJSONObject("session")
        val participant = response.getJSONObject("participant")
        val formUrl = session.getString("gform_url")
        if (!isAllowedExamUrl(formUrl)) throw IllegalStateException("URL Google Forms tidak valid.")

        sessionId = session.getString("id")
        inExam = true
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
            if (failure != null) runOnUiThread {
                Toast.makeText(this, failure, Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun eventPayload(action: String) = JSONObject()
        .put("action", action)
        .put("nis", nis)
        .put("participant_token", participantToken)
        .put("session_id", sessionId)

    private fun leaveExam() {
        handler.removeCallbacks(heartbeat)
        inExam = false
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

    private fun showConfigurationDialog() {
        val urlInput = input("Project URL").apply { setText(preferences.getString(KEY_PROJECT_URL, "")) }
        val keyInput = input("Anon/public key").apply {
            setText(preferences.getString(KEY_ANON_KEY, ""))
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(8), dp(20), 0)
            addView(urlInput)
            addView(keyInput)
        }
        AlertDialog.Builder(this)
            .setTitle("Pengaturan koneksi")
            .setView(content)
            .setNegativeButton("Batal", null)
            .setPositiveButton("Simpan") { _, _ ->
                val url = urlInput.text.toString().trim().trimEnd('/')
                val key = keyInput.text.toString().trim()
                val parsed = runCatching { URL(url) }.getOrNull()
                if (parsed?.protocol != "https" || key.isBlank()) {
                    message("URL HTTPS dan anon/public key wajib diisi.")
                } else {
                    preferences.edit().putString(KEY_PROJECT_URL, url).putString(KEY_ANON_KEY, key).apply()
                    showJoinScreen()
                }
            }
            .show()
    }

    private fun sendRequest(payload: JSONObject, callback: (JSONObject?, String?) -> Unit) {
        val projectUrl = preferences.getString(KEY_PROJECT_URL, "").orEmpty()
        val anonKey = preferences.getString(KEY_ANON_KEY, "").orEmpty()
        executor.execute {
            var connection: HttpURLConnection? = null
            try {
                connection = (URL("$projectUrl/functions/v1/participant-access").openConnection() as HttpURLConnection).apply {
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
                runOnUiThread { callback(if (failure == null) json else null, failure) }
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
        private const val KEY_PROJECT_URL = "project_url"
        private const val KEY_ANON_KEY = "anon_key"
        private const val JOIN_BUTTON_TAG = "join-button"
        private const val NETWORK_TIMEOUT_MS = 15_000
        private const val HEARTBEAT_INTERVAL_MS = 30_000L
        private const val FOCUS_LOSS_DEBOUNCE_MS = 10_000L
        private const val SURFACE = 0xFFF5F7FB.toInt()
        private const val INK = 0xFF17213A.toInt()
        private const val MUTED = 0xFF8290A8.toInt()
        private const val INDIGO = 0xFF5B65DF.toInt()
        private const val ERROR = 0xFFB54747.toInt()
    }
}
