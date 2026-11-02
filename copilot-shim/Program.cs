using ContainedCli;

using var signals = new ShutdownSignals();
try
{
    var executable = ContainedProcess.Executable("COPILOT_CLI_PATH");
    var version = ContainedProcess.Required("COPILOT_CLI_VERSION");
    await ContainedProcess.VerifyVersionAsync(executable, $"GitHub Copilot CLI {version}.", signals.Token);
    var start = ContainedProcess.Start(executable, args);
    if (!ContainedProcess.MetadataOnly(args))
    {
        var token = ContainedProcess.Required("COPILOT_GITHUB_TOKEN");
        start.Environment["COPILOT_GITHUB_TOKEN"] = token;
        start.Environment["GH_TOKEN"] = token;
        start.Environment.Remove("GITHUB_TOKEN");
    }
    return await ContainedProcess.RunAsync(start, signals.Token);
}
catch (OperationCanceledException) when (signals.Token.IsCancellationRequested)
{
    return signals.ExitCode;
}
catch (Exception error)
{
    Console.Error.WriteLine($"[copilot-shim] {error.Message}");
    return 1;
}
