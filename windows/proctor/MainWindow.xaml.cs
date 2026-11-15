using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;

namespace ExamPlus.Proctor;

public partial class MainWindow : Window
{
    private const int MinimumProctorCodeLength = 8;
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(15);
    private static readonly Brush Green = new SolidColorBrush(Color.FromRgb(17, 120, 95));
    private static readonly Brush Ink = new SolidColorBrush(Color.FromRgb(23, 53, 45));
    private static readonly Brush Muted = new SolidColorBrush(Color.FromRgb(112, 130, 123));
    private static readonly Brush Line = new SolidColorBrush(Color.FromRgb(225, 235, 230));
    private static readonly Brush Error = new SolidColorBrush(Color.FromRgb(181, 71, 71));
    private static readonly Brush White = Brushes.White;

    private readonly HttpClient _httpClient = new() { Timeout = RequestTimeout };
    private readonly DispatcherTimer _refreshTimer = new() { Interval = TimeSpan.FromSeconds(15) };
    private string _supabaseUrl = "";
    private string _anonKey = "";
    private string _roomName = "";
    private string _proctorCode = "";
    private string _selectedSessionId = "";
    private string _selectedSessionTitle = "";
    private IReadOnlyList<ExamSession> _sessions = [];
    private bool _isRefreshing;
    private TextBlock? _loginError;
    private TextBlock? _rosterSummary;

    public MainWindow()
    {
        InitializeComponent();
        _refreshTimer.Tick += async (_, _) => await LoadRosterAsync(silent: true);
    }

    private void Window_Loaded(object sender, RoutedEventArgs e)
    {
        try
        {
            LoadSharedConfig();
            ShowLogin();
        }
        catch (Exception error)
        {
            ShowMessage("Konfigurasi belum siap", error.Message);
        }
    }

    private void Window_Closed(object? sender, EventArgs e)
    {
        _refreshTimer.Stop();
        _httpClient.Dispose();
    }

    private void LoadSharedConfig()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "config", "supabase.json");
        if (!File.Exists(path))
        {
            throw new FileNotFoundException("File config/supabase.json tidak ditemukan.", path);
        }

        using var document = JsonDocument.Parse(File.ReadAllText(path));
        var root = document.RootElement;
        var urlValue = root.TryGetProperty("url", out var urlElement) ? urlElement.GetString()?.Trim() : null;
        var key = root.TryGetProperty("anonKey", out var keyElement) ? keyElement.GetString()?.Trim() : null;
        if (!Uri.TryCreate(urlValue, UriKind.Absolute, out var url) ||
            url.Scheme != Uri.UriSchemeHttps ||
            string.IsNullOrWhiteSpace(url.Host) ||
            url.Host.Contains("your_project_id", StringComparison.OrdinalIgnoreCase) ||
            !string.IsNullOrEmpty(url.UserInfo) ||
            url.AbsolutePath != "/" ||
            !string.IsNullOrEmpty(url.Query) ||
            !string.IsNullOrEmpty(url.Fragment))
        {
            throw new InvalidOperationException("URL project di config/supabase.json tidak valid.");
        }
        if (string.IsNullOrWhiteSpace(key) ||
            key.Contains("YOUR_SUPABASE", StringComparison.OrdinalIgnoreCase) ||
            IsServiceRoleKey(key))
        {
            throw new InvalidOperationException("Isi anonKey publik pada config/supabase.json; jangan gunakan service_role.");
        }

        _supabaseUrl = url.ToString().TrimEnd('/');
        _anonKey = key;
    }

    private static bool IsServiceRoleKey(string key)
    {
        var parts = key.Split('.');
        if (parts.Length != 3) return false;
        try
        {
            var payload = parts[1].Replace('-', '+').Replace('_', '/');
            payload = payload.PadRight(payload.Length + ((4 - payload.Length % 4) % 4), '=');
            using var document = JsonDocument.Parse(Convert.FromBase64String(payload));
            return document.RootElement.TryGetProperty("role", out var role) &&
                role.GetString() == "service_role";
        }
        catch (FormatException)
        {
            return false;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private async Task<T> SendRequestAsync<T>(Dictionary<string, object?> payload)
    {
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"{_supabaseUrl}/functions/v1/proctor-access");
        request.Headers.Add("apikey", _anonKey);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _anonKey);
        request.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

        using var response = await _httpClient.SendAsync(request);
        var body = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(ReadApiError(body, (int)response.StatusCode));
        }

        return JsonSerializer.Deserialize<T>(body) ??
            throw new InvalidOperationException("Respons server tidak valid.");
    }

    private static string ReadApiError(string body, int statusCode)
    {
        try
        {
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            if (statusCode == 404 &&
                root.TryGetProperty("code", out var code) &&
                code.ValueKind == JsonValueKind.String &&
                code.GetString() == "NOT_FOUND")
            {
                return "Edge Function proctor-access belum ditemukan pada project di config/supabase.json. " +
                    "Periksa URL project, lalu deploy dengan: supabase functions deploy proctor-access";
            }
            if (root.TryGetProperty("error", out var error) &&
                error.ValueKind == JsonValueKind.String &&
                !string.IsNullOrWhiteSpace(error.GetString()))
            {
                return error.GetString()!;
            }
            if (root.TryGetProperty("message", out var message) &&
                message.ValueKind == JsonValueKind.String &&
                !string.IsNullOrWhiteSpace(message.GetString()))
            {
                return message.GetString()!;
            }
        }
        catch (JsonException)
        {
        }

        return $"Permintaan gagal (HTTP {statusCode}).";
    }

    private void ShowLogin(string? error = null)
    {
        var card = NewCard();
        card.Width = 500;
        card.HorizontalAlignment = HorizontalAlignment.Center;
        card.VerticalAlignment = VerticalAlignment.Center;
        var content = new StackPanel();
        content.Children.Add(Text("Masuk pengawas", 27, Ink, bold: true));
        content.Children.Add(Text(
            "Masukkan nama ruang dan kode rahasia pengawas untuk melihat pelajaran aktif.",
            14,
            Muted,
            margin: new Thickness(0, 7, 0, 22)));
        content.Children.Add(Label("NAMA RUANG"));
        var roomInput = Input("Contoh: Ruang 1");
        content.Children.Add(roomInput);
        content.Children.Add(Label("KODE PENGAWAS", new Thickness(0, 16, 0, 6)));
        var codeInput = new PasswordBox
        {
            Height = 48,
            Padding = new Thickness(14, 11, 14, 11),
            FontSize = 15,
            BorderBrush = Line,
            BorderThickness = new Thickness(1),
            ToolTip = "Masukkan kode pengawas minimal 8 karakter",
        };
        content.Children.Add(codeInput);
        _loginError = Text(error ?? "", 12, Error, margin: new Thickness(0, 10, 0, 8));
        _loginError.TextWrapping = TextWrapping.Wrap;
        content.Children.Add(_loginError);
        var loginButton = PrimaryButton("Masuk ke panel");
        loginButton.Click += async (_, _) => await LoginAsync(roomInput, codeInput, loginButton);
        content.Children.Add(loginButton);
        content.Children.Add(Text(
            "Kode pengawas hanya disimpan sementara di memori aplikasi.",
            11,
            Muted,
            horizontalAlignment: HorizontalAlignment.Center,
            margin: new Thickness(0, 16, 0, 0)));
        card.Child = content;
        PageHost.Content = Centered(card);
        LogoutButton.Visibility = Visibility.Collapsed;
        HeaderStatus.Text = "Pemantauan ruang ujian";
    }

    private async Task LoginAsync(TextBox roomInput, PasswordBox codeInput, Button button)
    {
        var room = roomInput.Text.Trim();
        var code = codeInput.Password.Trim();
        if (string.IsNullOrWhiteSpace(room) || room.Length > 120 || code.Length < MinimumProctorCodeLength)
        {
            if (_loginError is not null)
                _loginError.Text = "Masukkan nama ruang dan kode pengawas minimal 8 karakter.";
            return;
        }

        SetBusy(button, true, "Memverifikasi…");
        try
        {
            var response = await SendRequestAsync<LoginResponse>(Credentials("login", room, code));
            if (response.Room is null || string.IsNullOrWhiteSpace(response.Room.RoomName))
                throw new InvalidOperationException("Data ruang dari server tidak lengkap.");

            _roomName = response.Room.RoomName;
            _proctorCode = code;
            _sessions = response.Sessions ?? [];
            LogoutButton.Visibility = Visibility.Visible;
            HeaderStatus.Text = $"Ruang {_roomName}";
            ShowSessionPicker();
        }
        catch (Exception error)
        {
            if (_loginError is not null) _loginError.Text = error.Message;
        }
        finally
        {
            SetBusy(button, false, "Masuk ke panel");
        }
    }

    private void ShowSessionPicker()
    {
        _refreshTimer.Stop();
        var content = new StackPanel { MaxWidth = 900, HorizontalAlignment = HorizontalAlignment.Center };
        var card = NewCard();
        card.Children.Add(Text("Pelajaran aktif", 24, Ink, bold: true));
        card.Children.Add(Text(
            $"Pilih pelajaran untuk membuka daftar peserta di ruang {_roomName}.",
            14,
            Muted,
            margin: new Thickness(0, 6, 0, 16)));

        if (_sessions.Count == 0)
        {
            card.Children.Add(Text(
                "Belum ada pelajaran aktif untuk ruang ini.",
                14,
                Muted,
                horizontalAlignment: HorizontalAlignment.Center,
                margin: new Thickness(0, 24, 0, 24)));
        }
        else
        {
            foreach (var session in _sessions)
            {
                var button = new Button
                {
                    Content = SessionButtonContent(session),
                    HorizontalContentAlignment = HorizontalAlignment.Left,
                    Padding = new Thickness(16, 12, 16, 12),
                    Margin = new Thickness(0, 6, 0, 0),
                    Background = White,
                    BorderBrush = Line,
                    BorderThickness = new Thickness(1),
                    Cursor = System.Windows.Input.Cursors.Hand,
                    Tag = session,
                };
                button.Click += async (_, _) =>
                {
                    if (button.Tag is ExamSession chosen)
                    {
                        _selectedSessionId = chosen.Id;
                        _selectedSessionTitle = chosen.Title;
                        await LoadRosterAsync(silent: false);
                    }
                };
                card.Children.Add(button);
            }
        }

        var actions = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 18, 0, 0),
        };
        var refresh = SecondaryButton("Muat ulang pelajaran");
        refresh.Margin = new Thickness(0, 0, 8, 0);
        refresh.Click += async (_, _) => await RefreshSessionsAsync(refresh);
        actions.Children.Add(refresh);
        actions.Children.Add(SecondaryButton("Keluar", LogoutButton_Click));
        card.Children.Add(actions);
        content.Children.Add(card);
        PageHost.Content = Centered(content);
    }

    private async Task RefreshSessionsAsync(Button button)
    {
        SetBusy(button, true, "Memuat…");
        try
        {
            var response = await SendRequestAsync<LoginResponse>(Credentials("login"));
            _sessions = response.Sessions ?? [];
            ShowSessionPicker();
        }
        catch (Exception error)
        {
            HeaderStatus.Text = error.Message;
        }
        finally
        {
            if (button.IsLoaded) SetBusy(button, false, "Muat ulang pelajaran");
        }
    }

    private async Task LoadRosterAsync(bool silent)
    {
        if (_isRefreshing || string.IsNullOrWhiteSpace(_selectedSessionId)) return;
        _isRefreshing = true;
        try
        {
            var payload = Credentials("roster");
            payload["session_id"] = _selectedSessionId;
            var response = await SendRequestAsync<RosterResponse>(payload);
            if (string.IsNullOrWhiteSpace(_selectedSessionId)) return;
            ShowRoster(response.Session ?? new ExamSession(), response.Roster ?? []);
        }
        catch (Exception error)
        {
            HeaderStatus.Text = error.Message;
            if (!silent)
            {
                _selectedSessionId = "";
                ShowSessionPicker();
                MessageBox.Show(this, error.Message, "Gagal memuat peserta", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }
        finally
        {
            _isRefreshing = false;
        }
    }

    private void ShowRoster(ExamSession session, IReadOnlyList<Participant> roster)
    {
        var page = new StackPanel { MaxWidth = 1040, HorizontalAlignment = HorizontalAlignment.Center };
        var heading = new Grid { Margin = new Thickness(0, 0, 0, 14) };
        heading.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        heading.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var title = new StackPanel();
        title.Children.Add(Text("Pemantauan ruang", 25, Ink, bold: true));
        title.Children.Add(Text(
            $"{_selectedSessionTitle}  ·  Ruang {_roomName}",
            14,
            Muted,
            margin: new Thickness(0, 4, 0, 0)));
        heading.Children.Add(title);
        var backButton = SecondaryButton("Pilih pelajaran");
        backButton.VerticalAlignment = VerticalAlignment.Center;
        backButton.Click += (_, _) =>
        {
            _selectedSessionId = "";
            _refreshTimer.Stop();
            ShowSessionPicker();
        };
        Grid.SetColumn(backButton, 1);
        heading.Children.Add(backButton);
        page.Children.Add(heading);

        var summary = NewCard();
        var blockedCount = roster.Count(item => item.Status == "blocked");
        var alarmCount = roster.Count(item => item.AlarmActive);
        _rosterSummary = Text("", 14, Muted);
        summary.Children.Add(Text(session.Title, 19, Ink, bold: true));
        _rosterSummary.Text = $"{roster.Count} peserta  ·  {blockedCount} diblokir  ·  {alarmCount} alarm aktif";
        _rosterSummary.Margin = new Thickness(0, 5, 0, 0);
        summary.Children.Add(_rosterSummary);
        var manualRefresh = SecondaryButton("Segarkan daftar");
        manualRefresh.Margin = new Thickness(0, 12, 0, 0);
        manualRefresh.Click += async (_, _) => await LoadRosterAsync(silent: false);
        summary.Children.Add(manualRefresh);
        page.Children.Add(summary);

        if (roster.Count == 0)
        {
            var empty = NewCard();
            empty.Margin = new Thickness(0, 12, 0, 0);
            empty.Children.Add(Text(
                "Belum ada peserta pada pelajaran ini.",
                14,
                Muted,
                horizontalAlignment: HorizontalAlignment.Center));
            page.Children.Add(empty);
        }

        foreach (var participant in roster)
        {
            var card = CreateParticipantCard(participant);
            card.Margin = new Thickness(0, 12, 0, 0);
            page.Children.Add(card);
        }

        PageHost.Content = page;
        HeaderStatus.Text = $"Ruang {_roomName}  ·  diperbarui {DateTime.Now:HH:mm:ss}";
        _refreshTimer.Stop();
        _refreshTimer.Start();
    }

    private Border CreateParticipantCard(Participant participant)
    {
        var card = NewCard();
        var header = new Grid();
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var identity = new StackPanel();
        identity.Children.Add(Text(participant.Name, 17, Ink, bold: true));
        identity.Children.Add(Text(
            $"NIS {participant.Nis}  ·  {participant.OriginalClass}",
            12,
            Muted,
            margin: new Thickness(0, 3, 0, 0)));
        header.Children.Add(identity);
        var badge = StatusBadge(participant.Status);
        badge.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(badge, 1);
        header.Children.Add(badge);
        card.Children.Add(header);
        card.Children.Add(Text(
            $"Ruang {_roomName}  ·  Kursi {participant.SeatNumber}  ·  Pelanggaran {participant.ViolationCount}",
            12,
            Muted,
            margin: new Thickness(0, 10, 0, 3)));
        card.Children.Add(Text(
            participant.LastHeartbeat is null
                ? "Belum terhubung"
                : $"Terakhir aktif: {FormatDate(participant.LastHeartbeat)}",
            11,
            Muted));

        var actions = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 12, 0, 0),
        };
        if (participant.AlarmActive && !string.IsNullOrWhiteSpace(participant.LogId))
        {
            var mute = PrimaryButton("Matikan alarm");
            mute.Background = new SolidColorBrush(Color.FromRgb(166, 69, 50));
            mute.Margin = new Thickness(0, 0, 8, 0);
            mute.Click += async (_, _) => await RunProctorActionAsync("mute_alarm", participant, mute);
            actions.Children.Add(mute);
        }
        if (participant.Status == "blocked" && !string.IsNullOrWhiteSpace(participant.LogId))
        {
            var resume = PrimaryButton("Izinkan lanjut");
            resume.Click += async (_, _) => await RunProctorActionAsync("resume_participant", participant, resume);
            actions.Children.Add(resume);
        }
        if (actions.Children.Count > 0) card.Children.Add(actions);
        return card;
    }

    private async Task RunProctorActionAsync(string action, Participant participant, Button button)
    {
        if (string.IsNullOrWhiteSpace(participant.LogId)) return;
        SetBusy(button, true, "Memproses…");
        try
        {
            var payload = Credentials(action);
            payload["session_id"] = _selectedSessionId;
            payload["log_id"] = participant.LogId;
            await SendRequestAsync<ActionResponse>(payload);
            HeaderStatus.Text = action == "mute_alarm"
                ? "Alarm peserta dimatikan. Ujian tetap dijeda."
                : "Peserta diizinkan melanjutkan ujian.";
            await LoadRosterAsync(silent: true);
        }
        catch (Exception error)
        {
            MessageBox.Show(this, error.Message, "Tindakan gagal", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        finally
        {
            if (button.IsLoaded) SetBusy(button, false, action == "mute_alarm" ? "Matikan alarm" : "Izinkan lanjut");
        }
    }

    private void LogoutButton_Click(object sender, RoutedEventArgs e)
    {
        _refreshTimer.Stop();
        _roomName = "";
        _proctorCode = "";
        _selectedSessionId = "";
        _selectedSessionTitle = "";
        _sessions = [];
        LogoutButton.Visibility = Visibility.Collapsed;
        ShowLogin();
    }

    private Dictionary<string, object?> Credentials(string action, string? room = null, string? code = null) =>
        new()
        {
            ["action"] = action,
            ["room_name"] = room ?? _roomName,
            ["proctor_code"] = code ?? _proctorCode,
        };

    private void ShowMessage(string title, string detail)
    {
        var card = NewCard();
        card.Width = 560;
        card.HorizontalAlignment = HorizontalAlignment.Center;
        card.VerticalAlignment = VerticalAlignment.Center;
        card.Children.Add(Text(title, 24, Ink, bold: true));
        card.Children.Add(Text(detail, 14, Muted, margin: new Thickness(0, 8, 0, 0)));
        PageHost.Content = Centered(card);
    }

    private static StackPanel SessionButtonContent(ExamSession session)
    {
        var content = new StackPanel();
        content.Children.Add(Text(session.Title, 16, Ink, bold: true));
        content.Children.Add(Text(
            $"{FormatDate(session.StartTime)}  –  {FormatDate(session.EndTime)}",
            12,
            Muted,
            margin: new Thickness(0, 4, 0, 0)));
        return content;
    }

    private static Border StatusBadge(string status)
    {
        var (label, background, foreground) = status switch
        {
            "blocked" => ("Perlu pengawas", Color.FromRgb(255, 230, 226), Color.FromRgb(170, 62, 53)),
            "in_exam" => ("Sedang ujian", Color.FromRgb(223, 242, 233), Color.FromRgb(22, 116, 81)),
            "logged_in" => ("Sudah masuk", Color.FromRgb(255, 241, 217), Color.FromRgb(138, 99, 35)),
            "finished" => ("Selesai", Color.FromRgb(233, 237, 242), Color.FromRgb(97, 112, 128)),
            _ => ("Belum masuk", Color.FromRgb(255, 241, 217), Color.FromRgb(138, 99, 35)),
        };
        return new Border
        {
            Background = new SolidColorBrush(background),
            CornerRadius = new CornerRadius(14),
            Padding = new Thickness(11, 6, 11, 6),
            Child = Text(label, 11, new SolidColorBrush(foreground), bold: true),
        };
    }

    private static CardPanel NewCard() => new()
    {
        Background = White,
        BorderBrush = Line,
        BorderThickness = new Thickness(1),
        CornerRadius = new CornerRadius(18),
        Padding = new Thickness(22),
    };

    private static TextBlock Text(
        string value,
        double size,
        Brush color,
        bool bold = false,
        HorizontalAlignment horizontalAlignment = HorizontalAlignment.Left,
        Thickness? margin = null) =>
        new()
        {
            Text = value,
            FontSize = size,
            Foreground = color,
            FontWeight = bold ? FontWeights.Bold : FontWeights.Normal,
            TextWrapping = TextWrapping.Wrap,
            HorizontalAlignment = horizontalAlignment,
            Margin = margin ?? new Thickness(0),
        };

    private static TextBlock Label(string value, Thickness? margin = null) =>
        Text(value, 11, Ink, bold: true, margin: margin ?? new Thickness(0, 0, 0, 6));

    private static TextBox Input(string hint) => new()
    {
        Height = 48,
        Padding = new Thickness(14, 11, 14, 11),
        FontSize = 15,
        BorderBrush = Line,
        BorderThickness = new Thickness(1),
        ToolTip = hint,
    };

    private static Button PrimaryButton(string text) => new()
    {
        Content = text,
        Height = 44,
        Padding = new Thickness(18, 8, 18, 8),
        Background = Green,
        Foreground = White,
        BorderThickness = new Thickness(0),
        FontSize = 13,
        FontWeight = FontWeights.SemiBold,
        Cursor = System.Windows.Input.Cursors.Hand,
    };

    private static Button SecondaryButton(string text, RoutedEventHandler? click = null)
    {
        var button = new Button
        {
            Content = text,
            Height = 40,
            Padding = new Thickness(14, 7, 14, 7),
            Background = White,
            Foreground = Green,
            BorderBrush = Line,
            FontSize = 12,
            FontWeight = FontWeights.SemiBold,
            Cursor = System.Windows.Input.Cursors.Hand,
        };
        if (click is not null) button.Click += click;
        return button;
    }

    private static void SetBusy(Button button, bool busy, string text)
    {
        button.IsEnabled = !busy;
        button.Content = text;
    }

    private static ScrollViewer Centered(UIElement content) => new()
    {
        Content = content,
        VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
        HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
        HorizontalContentAlignment = HorizontalAlignment.Center,
        VerticalContentAlignment = VerticalAlignment.Center,
    };

    private static string FormatDate(string? value)
    {
        if (!DateTimeOffset.TryParse(value, CultureInfo.GetCultureInfo("id-ID"), DateTimeStyles.AssumeUniversal, out var date))
            return value ?? "-";
        return date.ToLocalTime().ToString("dd MMM yyyy, HH:mm", CultureInfo.GetCultureInfo("id-ID"));
    }

    private sealed class CardPanel : Border
    {
        private readonly StackPanel _content = new();

        public UIElementCollection Children => _content.Children;

        public CardPanel()
        {
            Child = _content;
        }
    }

    private sealed class ActionResponse
    {
        public ActionResponse() { }
    }

    private sealed class LoginResponse
    {
        public LoginResponse() { }

        [JsonPropertyName("room")]
        public RoomInfo? Room { get; set; }

        [JsonPropertyName("sessions")]
        public List<ExamSession>? Sessions { get; set; }
    }

    private sealed class RoomInfo
    {
        public RoomInfo() { }

        [JsonPropertyName("room_name")]
        public string RoomName { get; set; } = "";
    }

    private sealed class RosterResponse
    {
        public RosterResponse() { }

        [JsonPropertyName("session")]
        public ExamSession? Session { get; set; }

        [JsonPropertyName("roster")]
        public List<Participant>? Roster { get; set; }
    }

    private sealed class ExamSession
    {
        public ExamSession() { }

        [JsonPropertyName("id")]
        public string Id { get; set; } = "";

        [JsonPropertyName("title")]
        public string Title { get; set; } = "Pelajaran";

        [JsonPropertyName("start_time")]
        public string StartTime { get; set; } = "";

        [JsonPropertyName("end_time")]
        public string EndTime { get; set; } = "";
    }

    private sealed class Participant
    {
        public Participant() { }

        [JsonPropertyName("log_id")]
        public string? LogId { get; set; }

        [JsonPropertyName("nis")]
        public string Nis { get; set; } = "";

        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("original_class")]
        public string OriginalClass { get; set; } = "";

        [JsonPropertyName("seat_number")]
        public int SeatNumber { get; set; }

        [JsonPropertyName("status")]
        public string Status { get; set; } = "not_started";

        [JsonPropertyName("violation_count")]
        public int ViolationCount { get; set; }

        [JsonPropertyName("last_heartbeat")]
        public string? LastHeartbeat { get; set; }

        [JsonPropertyName("alarm_active")]
        public bool AlarmActive { get; set; }
    }
}
