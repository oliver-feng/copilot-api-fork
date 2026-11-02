using System.Diagnostics;
using System.Runtime.InteropServices;

namespace ContainedCli;

internal sealed class ShutdownSignals : IDisposable
{
    private readonly CancellationTokenSource cancellation = new();
    private readonly PosixSignalRegistration? termination;
    public CancellationToken Token => cancellation.Token;
    public int ExitCode { get; private set; } = 130;

    public ShutdownSignals()
    {
        Console.CancelKeyPress += Cancel;
        if (!OperatingSystem.IsWindows())
            termination = PosixSignalRegistration.Create(PosixSignal.SIGTERM, context =>
            {
                context.Cancel = true;
                ExitCode = 143;
                cancellation.Cancel();
            });
    }

    private void Cancel(object? sender, ConsoleCancelEventArgs args)
    {
        args.Cancel = true;
        cancellation.Cancel();
    }

    public void Dispose()
    {
        Console.CancelKeyPress -= Cancel;
        termination?.Dispose();
        cancellation.Dispose();
    }
}

internal static class ContainedProcess
{
    public static string Required(string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrWhiteSpace(value) || value.Any(char.IsControl))
            throw new InvalidOperationException($"{name} must be supplied at runtime.");
        return value;
    }

    public static string Executable(string name)
    {
        var path = Environment.GetEnvironmentVariable(name)
            ?? throw new InvalidOperationException($"{name} must point to the CLI installed during preparation.");
        if (!Path.IsPathFullyQualified(path) || !File.Exists(path))
            throw new InvalidOperationException($"{name} must point to an existing absolute executable path.");
        return path;
    }

    public static bool MetadataOnly(string[] args) =>
        args.Length == 1 && args[0] is "--help" or "--version" or "-h";

    public static ProcessStartInfo Start(string command, IEnumerable<string> args)
    {
        var start = new ProcessStartInfo(command) { UseShellExecute = false };
        foreach (var argument in args) start.ArgumentList.Add(argument);
        return start;
    }

    public static async Task<int> RunAsync(ProcessStartInfo start, CancellationToken ct)
    {
        using var process = Process.Start(start) ?? throw new InvalidOperationException("The prepared CLI could not start.");
        try
        {
            await process.WaitForExitAsync(ct);
            return process.ExitCode;
        }
        finally { await StopAsync(process); }
    }

    public static async Task VerifyVersionAsync(string executable, string expected, CancellationToken ct)
    {
        var start = Start(executable, ["--version"]);
        start.Environment.Clear();
        foreach (var key in new[] { "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "WINDIR" })
            if (Environment.GetEnvironmentVariable(key) is { } value) start.Environment[key] = value;
        start.Environment["DISABLE_AUTOUPDATER"] = "1";
        start.Environment["DISABLE_UPDATES"] = "1";
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        using var process = Process.Start(start) ?? throw new InvalidOperationException("CLI version verification could not start.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        try
        {
            await process.WaitForExitAsync(timeout.Token);
            var actual = (await stdout).Trim().Split('\n')[0].TrimEnd('\r');
            if (process.ExitCode != 0 || actual != expected)
                throw new InvalidOperationException($"Prepared CLI version mismatch; expected {expected}.");
        }
        catch (OperationCanceledException error) when (!ct.IsCancellationRequested)
        {
            throw new TimeoutException("CLI version verification timed out.", error);
        }
        finally
        {
            await StopAsync(process);
            await Task.WhenAll(stdout, stderr);
        }
    }

    public static async Task StopAsync(Process process)
    {
        if (!process.HasExited)
        {
            try { process.Kill(entireProcessTree: true); }
            catch (InvalidOperationException) when (process.HasExited) { }
            await process.WaitForExitAsync(CancellationToken.None);
        }
    }
}
