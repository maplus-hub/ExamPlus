using Microsoft.Web.WebView2.Core;
using System.ComponentModel;
using System.Diagnostics;
using System.Text.Json;
using System.Windows;
using System.Windows.Threading;

namespace ExamPlus.Participant;

public partial class MainWindow : Window
{
    private const string VirtualHost = "examplus.local";
    private bool _examActive;
    private bool _violationActive;
    private SupervisorPromptWindow? _supervisorPrompt;
    private readonly DispatcherTimer _alarmTimer = new() { Interval = TimeSpan.FromSeconds(1.2) };

    private static readonly HashSet<string> AllowedGoogleHosts = new(StringComparer.OrdinalIgnoreCase)
    {
        "docs.google.com",
        "accounts.google.com",
        "accounts.google.co.id",
        "google.com",
        "www.google.com",
        "drive.google.com",
        "support.google.com"
    };

    public MainWindow()
    {
        InitializeComponent();
        _alarmTimer.Tick += (_, _) => System.Media.SystemSounds.Hand.Play();
    }

    private async void Window_Loaded(object sender, RoutedEventArgs e)
    {
        try
        {
            await ExamBrowser.EnsureCoreWebView2Async();
            var core = ExamBrowser.CoreWebView2;
            core.SetVirtualHostNameToFolderMapping(
                VirtualHost,
                AppContext.BaseDirectory,
                CoreWebView2HostResourceAccessKind.Allow);

            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;

            core.NavigationStarting += Core_NavigationStarting;
            core.NewWindowRequested += Core_NewWindowRequested;
            core.WebMessageReceived += Core_WebMessageReceived;
            core.Navigate($"https://{VirtualHost}/student.html");
        }
        catch (Exception error)
        {
            MessageBox.Show(
                $"Aplikasi peserta tidak dapat dijalankan. Pastikan Microsoft Edge WebView2 Runtime tersedia.\n\n{error.Message}",
                "ExamPlus Peserta",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            Close();
        }
    }

    private void Core_NavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        e.Cancel = !IsAllowedNavigation(e.Uri);
    }

    private void Core_NewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (IsAllowedNavigation(e.Uri))
        {
            ExamBrowser.CoreWebView2.Navigate(e.Uri);
        }
    }

    private void Core_WebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!Uri.TryCreate(e.Source, UriKind.Absolute, out var source) ||
            !source.Host.Equals(VirtualHost, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        try
        {
            using var message = JsonDocument.Parse(e.WebMessageAsJson);
            var root = message.RootElement;
            if (!root.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String)
            {
                return;
            }

            switch (type.GetString())
            {
                case "exam-state":
                    if (root.TryGetProperty("active", out var active) &&
                        (active.ValueKind == JsonValueKind.True || active.ValueKind == JsonValueKind.False))
                    {
                        _examActive = active.GetBoolean();
                    }
                    break;
                case "violation":
                    _violationActive = true;
                    ShowSupervisorPrompt(alarmActive: true);
                    StartAlarm();
                    break;
                case "alarm-state":
                    if (root.TryGetProperty("active", out var alarmActive) &&
                        (alarmActive.ValueKind == JsonValueKind.True || alarmActive.ValueKind == JsonValueKind.False))
                    {
                        var isActive = alarmActive.GetBoolean();
                        _supervisorPrompt?.SetAlarmActive(isActive);
                        if (isActive) StartAlarm();
                        else StopAlarm();
                    }
                    break;
                case "resume-error":
                    if (root.TryGetProperty("message", out var errorMessage) &&
                        errorMessage.ValueKind == JsonValueKind.String)
                    {
                        _supervisorPrompt?.ShowError(errorMessage.GetString() ?? "Kode pengawas tidak dapat diverifikasi.");
                    }
                    break;
                case "exam-resumed":
                    CompleteResume();
                    break;
                case "exam-stopped":
                    _examActive = false;
                    CompleteResume();
                    break;
            }
        }
        catch (JsonException error)
        {
            Debug.WriteLine($"Invalid ExamPlus WebView message: {error.Message}");
        }
    }

    private async void Window_Deactivated(object? sender, EventArgs e)
    {
        if (!_examActive || _violationActive || ExamBrowser.CoreWebView2 is not { } core)
        {
            return;
        }

        try
        {
            await core.ExecuteScriptAsync("window.dispatchEvent(new Event('examplus-native-focus-loss'));");
        }
        catch (Exception error)
        {
            Debug.WriteLine($"Unable to notify participant page about focus loss: {error.Message}");
        }
    }

    private void Window_Closing(object? sender, CancelEventArgs e)
    {
        if (!_examActive)
        {
            return;
        }

        e.Cancel = true;
        _ = ShowExitWarningAsync();
    }

    private void ShowSupervisorPrompt(bool alarmActive)
    {
        if (_supervisorPrompt is null)
        {
            _supervisorPrompt = new SupervisorPromptWindow
            {
                Owner = this,
                ResumeRequested = SendProctorCodeAsync,
            };
            _supervisorPrompt.Closed += (_, _) => _supervisorPrompt = null;
        }

        _supervisorPrompt.SetAlarmActive(alarmActive);
        if (!_supervisorPrompt.IsVisible) _supervisorPrompt.Show();
        _supervisorPrompt.Activate();
    }

    private void StartAlarm()
    {
        if (_alarmTimer.IsEnabled) return;
        System.Media.SystemSounds.Hand.Play();
        _alarmTimer.Start();
    }

    private void StopAlarm() => _alarmTimer.Stop();

    private async Task SendProctorCodeAsync(string code)
    {
        if (ExamBrowser.CoreWebView2 is not { } core)
        {
            throw new InvalidOperationException("Halaman ujian belum siap. Coba lagi.");
        }

        var serializedCode = JsonSerializer.Serialize(code);
        await core.ExecuteScriptAsync(
            $"window.dispatchEvent(new CustomEvent('examplus-native-resume', {{ detail: {serializedCode} }}));");
    }

    private void CompleteResume()
    {
        _violationActive = false;
        StopAlarm();
        if (_supervisorPrompt is not null)
        {
            var prompt = _supervisorPrompt;
            _supervisorPrompt = null;
            prompt.Dismiss();
        }
    }

    private async Task ShowExitWarningAsync()
    {
        try
        {
            var message = JsonSerializer.Serialize("Minta bantuan pengawas untuk keluar dari ujian.");
            await ExamBrowser.CoreWebView2.ExecuteScriptAsync(
                $"document.getElementById('participant-alert').textContent = {message};");
        }
        catch (Exception error)
        {
            Debug.WriteLine($"Unable to show participant exit warning: {error.Message}");
        }
    }

    private static bool IsAllowedNavigation(string value)
    {
        return Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
            uri.Scheme == Uri.UriSchemeHttps &&
            (uri.Host.Equals(VirtualHost, StringComparison.OrdinalIgnoreCase) ||
             AllowedGoogleHosts.Contains(uri.Host));
    }
}
