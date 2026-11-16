package com.examplus.participant

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.Settings
import android.view.Gravity
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class ViolationAlarmService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()
    private var supabaseUrl = ""
    private var anonKey = ""
    private var nis = ""
    private var participantToken = ""
    private var sessionId = ""
    private var windowManager: WindowManager? = null
    private var overlay: LinearLayout? = null
    private var statusText: TextView? = null
    private var codeInput: EditText? = null
    private var resumeButton: Button? = null
    private var retryButton: Button? = null
    private var alarmTone: ToneGenerator? = null
    private var alarmActive = false
    private var violationRecorded = false
    private var requestInFlight = false
    private var savedAlarmVolume: Int? = null

    private val alarmLoop = object : Runnable {
        override fun run() {
            if (!alarmActive) return
            startAlarmTone()
            handler.postDelayed(this, ALARM_INTERVAL_MS)
        }
    }

    private val alarmPoll = object : Runnable {
        override fun run() {
            if (sessionId.isBlank()) return
            if (requestInFlight) {
                handler.postDelayed(this, ALARM_POLL_INTERVAL_MS)
                return
            }
            requestInFlight = true
            executor.execute {
                val (response, failure) = request(eventPayload("alarm_status"))
                handler.post {
                    requestInFlight = false
                    if (failure == null && response != null) {
                        if (response.optString("status") == "in_exam" ||
                            response.optString("status") == "logged_in"
                        ) {
                            // Stop sound/vibration synchronously before closing the service.
                            stopAlarm()
                            sendBroadcast(
                                Intent(ACTION_PROCTOR_RESUMED)
                                    .setPackage(packageName)
                                    .putExtra(EXTRA_RESUME_RESPONSE, response.toString())
                            )
                            stopSelf()
                            return@post
                        }
                        val shouldSound = response.optBoolean("alarm_active", false)
                        if (shouldSound) {
                            startAlarm()
                            setStatus("Alarm aktif. Ujian dijeda; masukkan kode pengawas untuk melanjutkan.")
                        } else {
                            stopAlarm()
                            setStatus("Alarm dimatikan pengawas. Ujian tetap dijeda; masukkan kode pengawas untuk melanjutkan.")
                        }
                    }
                    if (sessionId.isNotBlank()) handler.postDelayed(this, ALARM_POLL_INTERVAL_MS)
                }
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action != ACTION_START) {
            stopSelf(startId)
            return START_NOT_STICKY
        }

        if (sessionId.isNotBlank()) return START_NOT_STICKY

        supabaseUrl = intent.getStringExtra(EXTRA_SUPABASE_URL).orEmpty().trimEnd('/')
        anonKey = intent.getStringExtra(EXTRA_ANON_KEY).orEmpty()
        nis = intent.getStringExtra(EXTRA_NIS).orEmpty()
        participantToken = intent.getStringExtra(EXTRA_PARTICIPANT_TOKEN).orEmpty()
        sessionId = intent.getStringExtra(EXTRA_SESSION_ID).orEmpty()
        if (supabaseUrl.isBlank() || anonKey.isBlank() || nis.isBlank() ||
            participantToken.isBlank() || sessionId.isBlank()
        ) {
            stopSelf(startId)
            return START_NOT_STICKY
        }

        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification())
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        showOverlay()
        if (intent.getBooleanExtra(EXTRA_ALARM_ACTIVE, true)) startAlarm()
        if (intent.getBooleanExtra(EXTRA_RECORD_VIOLATION, true)) {
            recordViolation()
        } else {
            violationRecorded = true
            setStatus("Ujian dijeda. Masukkan kode pengawas untuk melanjutkan.")
            handler.postDelayed(alarmPoll, ALARM_POLL_INTERVAL_MS)
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        stopAlarm()
        removeOverlay()
        executor.shutdownNow()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    private fun showOverlay() {
        if (!Settings.canDrawOverlays(this) || overlay != null) return
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(14), dp(18), dp(12))
            setBackgroundColor(0xFF8F1D2C.toInt())
        }
        content.addView(TextView(this).apply {
            text = "EXAMPLUS · UJIAN DIJEDA"
            textSize = 17f
            setTextColor(Color.WHITE)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        content.addView(TextView(this).apply {
            text = "Pelanggaran terdeteksi. Minta kode pengawas untuk melanjutkan."
            textSize = 14f
            setTextColor(Color.WHITE)
            setPadding(0, dp(6), 0, dp(4))
        })
        codeInput = EditText(this).apply {
            hint = "Kode rahasia pengawas"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            imeOptions = EditorInfo.IME_ACTION_DONE
            filters = arrayOf(android.text.InputFilter.LengthFilter(128))
            setSingleLine(true)
            setTextColor(Color.WHITE)
            setHintTextColor(0xFFD8B8BC.toInt())
            backgroundTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
        }
        content.addView(codeInput)
        statusText = TextView(this).apply {
            text = "Mencatat pelanggaran…"
            textSize = 12f
            setTextColor(Color.WHITE)
            setPadding(0, dp(4), 0, dp(6))
        }
        content.addView(statusText)
        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
        }
        retryButton = Button(this).apply {
            text = "Coba catat ulang"
            isAllCaps = false
            setOnClickListener { recordViolation() }
        }
        buttons.addView(retryButton)
        resumeButton = Button(this).apply {
            text = "Lanjutkan"
            isAllCaps = false
            setOnClickListener { verifyProctorCode() }
        }
        buttons.addView(resumeButton)
        content.addView(buttons)
        overlay = content
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP
            y = dp(34)
            softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        }
        runCatching { windowManager?.addView(content, params) }
            .onFailure { setStatus("Overlay tidak dapat ditampilkan. Aktifkan izin tampil di atas aplikasi lain.") }
    }

    private fun removeOverlay() {
        overlay?.let { view -> runCatching { windowManager?.removeView(view) } }
        overlay = null
        statusText = null
        codeInput = null
        resumeButton = null
        retryButton = null
    }

    private fun recordViolation() {
        if (requestInFlight || violationRecorded) return
        requestInFlight = true
        retryButton?.isEnabled = false
        setStatus("Mencatat pelanggaran ke server…")
        executor.execute {
            val payload = eventPayload("focus_loss").put("pause_on_violation", true)
            val (_, failure) = request(payload)
            handler.post {
                requestInFlight = false
                retryButton?.isEnabled = true
                if (failure == null) {
                    violationRecorded = true
                    setStatus("Pelanggaran tercatat. Masukkan kode pengawas.")
                    handler.removeCallbacks(alarmPoll)
                    handler.postDelayed(alarmPoll, ALARM_POLL_INTERVAL_MS)
                } else {
                    setStatus("Gagal mencatat pelanggaran: $failure")
                }
            }
        }
    }

    private fun verifyProctorCode() {
        val code = codeInput?.text?.toString()?.trim().orEmpty()
        if (!violationRecorded) {
            setStatus("Tunggu pencatatan pelanggaran berhasil, atau tekan Coba catat ulang.")
            return
        }
        if (code.length < MIN_PROCTOR_CODE_LENGTH) {
            setStatus("Kode pengawas minimal 8 karakter.")
            return
        }
        if (requestInFlight) return
        requestInFlight = true
        resumeButton?.isEnabled = false
        retryButton?.isEnabled = false
        setStatus("Memverifikasi kode pengawas…")
        executor.execute {
            val (response, failure) = request(eventPayload("resume").put("proctor_code", code))
            handler.post {
                requestInFlight = false
                if (failure != null || response == null) {
                    setStatus(failure ?: "Respons server tidak valid.")
                    resumeButton?.isEnabled = true
                    retryButton?.isEnabled = true
                    return@post
                }
                // The server has accepted the code. Release alarm output now,
                // rather than waiting for onDestroy() to run.
                stopAlarm()
                val resumeIntent = Intent(ACTION_PROCTOR_RESUMED)
                    .setPackage(packageName)
                    .putExtra(EXTRA_RESUME_RESPONSE, response.toString())
                sendBroadcast(resumeIntent)
                stopSelf()
            }
        }
    }

    private fun startAlarm() {
        if (alarmActive) return
        alarmActive = true
        val audio = getSystemService(AUDIO_SERVICE) as AudioManager
        if (savedAlarmVolume == null) savedAlarmVolume = audio.getStreamVolume(AudioManager.STREAM_ALARM)
        forceMaximumAlarmVolume(audio)
        startAlarmTone()
        handler.removeCallbacks(alarmLoop)
        handler.postDelayed(alarmLoop, ALARM_INTERVAL_MS)
        runCatching {
            val vibrator = getSystemService(VIBRATOR_SERVICE) as? Vibrator
            if (vibrator?.hasVibrator() == true) {
                vibrator.vibrate(VibrationEffect.createWaveform(VIBRATION_PATTERN, 0))
            }
        }
        updateNotification()
    }

    private fun startAlarmTone() {
        if (!alarmActive) return
        runCatching {
            val audio = getSystemService(AUDIO_SERVICE) as AudioManager
            forceMaximumAlarmVolume(audio)
            alarmTone?.stopTone()
            if (alarmTone == null) alarmTone = ToneGenerator(AudioManager.STREAM_ALARM, 100)
            alarmTone?.startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, ALARM_TONE_DURATION_MS)
        }
    }

    private fun stopAlarm() {
        val wasActive = alarmActive
        alarmActive = false
        handler.removeCallbacks(alarmLoop)
        runCatching { alarmTone?.stopTone() }
        alarmTone?.release()
        alarmTone = null
        runCatching { (getSystemService(VIBRATOR_SERVICE) as? Vibrator)?.cancel() }
        val previousVolume = savedAlarmVolume
        if (previousVolume != null) {
            runCatching {
                val audio = getSystemService(AUDIO_SERVICE) as AudioManager
                audio.setStreamVolume(AudioManager.STREAM_ALARM, previousVolume, 0)
            }
            savedAlarmVolume = null
        }
        if (wasActive) updateNotification()
    }

    private fun forceMaximumAlarmVolume(audio: AudioManager) {
        val maximum = audio.getStreamMaxVolume(AudioManager.STREAM_ALARM)
        if (maximum > 0) audio.setStreamVolume(AudioManager.STREAM_ALARM, maximum, 0)
    }

    private fun eventPayload(action: String) = JSONObject()
        .put("action", action)
        .put("nis", nis)
        .put("participant_token", participantToken)
        .put("session_id", sessionId)

    private fun request(payload: JSONObject): Pair<JSONObject?, String?> {
        var connection: HttpURLConnection? = null
        return try {
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
            val response = runCatching { JSONObject(body) }.getOrNull() ?: JSONObject()
            val failure = if (status in 200..299) null else
                response.optString("error").ifBlank { "Permintaan gagal (HTTP $status)." }
            response to failure
        } catch (error: Exception) {
            null to (error.localizedMessage ?: "Tidak dapat menghubungi server.")
        } finally {
            connection?.disconnect()
        }
    }

    private fun setStatus(message: String) {
        statusText?.text = message
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(NOTIFICATION_CHANNEL) == null) {
            manager.createNotificationChannel(
                NotificationChannel(NOTIFICATION_CHANNEL, "Alarm ujian", NotificationManager.IMPORTANCE_LOW)
            )
        }
    }

    private fun buildNotification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, NOTIFICATION_CHANNEL)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle("ExamPlus: ujian dijeda")
            .setContentText(if (alarmActive) "Alarm pelanggaran sedang berbunyi." else "Menunggu kode pengawas.")
            .setCategory(Notification.CATEGORY_ALARM)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification() {
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, buildNotification())
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        const val ACTION_START = "com.examplus.participant.action.START_VIOLATION"
        const val ACTION_PROCTOR_RESUMED = "com.examplus.participant.action.PROCTOR_RESUMED"
        const val EXTRA_SUPABASE_URL = "supabase_url"
        const val EXTRA_ANON_KEY = "anon_key"
        const val EXTRA_NIS = "nis"
        const val EXTRA_PARTICIPANT_TOKEN = "participant_token"
        const val EXTRA_SESSION_ID = "session_id"
        const val EXTRA_ALARM_ACTIVE = "alarm_active"
        const val EXTRA_RECORD_VIOLATION = "record_violation"
        const val EXTRA_RESUME_RESPONSE = "resume_response"
        private const val NOTIFICATION_CHANNEL = "exam_violation_alarm"
        private const val NOTIFICATION_ID = 8701
        private const val NETWORK_TIMEOUT_MS = 15_000
        private const val ALARM_POLL_INTERVAL_MS = 2_500L
        private const val ALARM_INTERVAL_MS = 1_300L
        private const val ALARM_TONE_DURATION_MS = 1_100
        private const val MIN_PROCTOR_CODE_LENGTH = 8
        private val VIBRATION_PATTERN = longArrayOf(0, 350, 150, 350, 300)
    }
}
