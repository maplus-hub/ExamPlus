using System.ComponentModel;
using System.Windows;

namespace ExamPlus.Participant;

public partial class SupervisorPromptWindow : Window
{
    private bool _canClose;

    public Func<string, Task>? ResumeRequested { get; set; }

    public SupervisorPromptWindow()
    {
        InitializeComponent();
        Loaded += (_, _) => ProctorCode.Focus();
    }

    public void SetAlarmActive(bool active)
    {
        AlarmStatus.Text = active
            ? "Alarm aktif. Minta kode pengawas untuk melanjutkan ujian."
            : "Alarm dimatikan pengawas. Ujian tetap dijeda sampai pengawas mengizinkan lanjut.";
    }

    public void ShowError(string message)
    {
        StatusText.Text = message;
        ResumeButton.IsEnabled = true;
        ProctorCode.Clear();
        ProctorCode.Focus();
    }

    public void Dismiss()
    {
        _canClose = true;
        Close();
    }

    private async void ResumeButton_Click(object sender, RoutedEventArgs e)
    {
        var code = ProctorCode.Password.Trim();
        if (code.Length < 8)
        {
            ShowError("Kode pengawas minimal 8 karakter.");
            return;
        }

        if (ResumeRequested is null)
        {
            ShowError("Layanan verifikasi belum siap. Hubungi pengawas.");
            return;
        }

        ResumeButton.IsEnabled = false;
        ProctorCode.Clear();
        StatusText.Text = "Memverifikasi kode pengawas…";
        try
        {
            await ResumeRequested(code);
            StatusText.Text = "Menunggu hasil verifikasi…";
        }
        catch (Exception error)
        {
            ShowError(error.Message);
        }
    }

    private void Window_Closing(object? sender, CancelEventArgs e)
    {
        if (!_canClose) e.Cancel = true;
    }
}
