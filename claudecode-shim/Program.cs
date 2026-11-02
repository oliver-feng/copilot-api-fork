using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using ContainedCli;

using var signals = new ShutdownSignals();
try
{
    return await ClaudeCodeLauncher.RunAsync(args, signals.Token);
}
catch (OperationCanceledException) when (signals.Token.IsCancellationRequested)
{
    return signals.ExitCode;
}
catch (Exception error)
{
    Console.Error.WriteLine($"[claudecode-shim] {error.Message}");
    return 1;
}

internal static class ClaudeCodeLauncher
{
    public static async Task<int> RunAsync(string[] args, CancellationToken ct)
    {
        var executable = ContainedProcess.Executable("CLAUDE_CODE_PATH");
        var version = ContainedProcess.Required("CLAUDE_CODE_VERSION");
        await ContainedProcess.VerifyVersionAsync(executable, $"{version} (Claude Code)", ct);
        var cliStart = ContainedProcess.Start(executable, args);
        foreach (var key in new[] { "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FD", "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS",
            "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY" })
            cliStart.Environment.Remove(key);
        cliStart.Environment["DISABLE_AUTOUPDATER"] = "1";
        cliStart.Environment["DISABLE_UPDATES"] = "1";
        if (ContainedProcess.MetadataOnly(args))
            return await ContainedProcess.RunAsync(cliStart, ct);

        var token = ContainedProcess.Required("COPILOT_GITHUB_TOKEN");
        var model = ContainedProcess.Required("ANTHROPIC_MODEL");
        var secret = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var payload = Path.Combine(AppContext.BaseDirectory, "payload", "proxy.mjs");
        if (!File.Exists(payload)) throw new FileNotFoundException("The contained proxy payload is missing.", payload);
        var proxyStart = ContainedProcess.Start("node", [payload]);
        proxyStart.RedirectStandardInput = true;
        proxyStart.RedirectStandardOutput = true;
        proxyStart.RedirectStandardError = true;
        proxyStart.Environment.Clear();
        foreach (var key in new[] { "PATH", "HOME", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR",
            "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS" })
            if (Environment.GetEnvironmentVariable(key) is { } value) proxyStart.Environment[key] = value;
        proxyStart.Environment["COPILOT_GITHUB_TOKEN"] = token;
        proxyStart.Environment["CLAUDECODE_PROXY_AUTH_TOKEN"] = secret;
        proxyStart.Environment["ANTHROPIC_MODEL"] = model;
        if (Environment.GetEnvironmentVariable("COPILOT_ACCOUNT_TYPE") is { } account)
            proxyStart.Environment["COPILOT_ACCOUNT_TYPE"] = account;

        using var proxy = Process.Start(proxyStart) ?? throw new InvalidOperationException("The local Copilot proxy could not start.");
        proxy.StandardInput.Close();
        var ready = new TaskCompletionSource<Uri>(TaskCreationOptions.RunContinuationsAsynchronously);
        var output = ReadProxyAsync(proxy.StandardOutput, ready, token, secret);
        var errors = ReadProxyAsync(proxy.StandardError, null, token, secret);
        Process? cli = null;
        try
        {
            var url = await ready.Task.WaitAsync(TimeSpan.FromSeconds(90), ct);
            cliStart.Environment["ANTHROPIC_BASE_URL"] = url.AbsoluteUri.TrimEnd('/');
            cliStart.Environment["ANTHROPIC_AUTH_TOKEN"] = secret;
            cliStart.Environment["ANTHROPIC_MODEL"] = model;
            foreach (var key in new[] { "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL" })
                cliStart.Environment[key] = model;
            cliStart.Environment["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1";
            cli = Process.Start(cliStart) ?? throw new InvalidOperationException("The prepared Claude Code CLI could not start.");
            var cliExit = cli.WaitForExitAsync(ct);
            var proxyExit = proxy.WaitForExitAsync(ct);
            if (await Task.WhenAny(cliExit, proxyExit) == proxyExit)
            {
                ct.ThrowIfCancellationRequested();
                throw new InvalidOperationException("The local Copilot proxy exited while Claude Code was running.");
            }
            await cliExit;
            return cli.ExitCode;
        }
        finally
        {
            if (cli is not null)
            {
                await ContainedProcess.StopAsync(cli);
                cli.Dispose();
            }
            await ContainedProcess.StopAsync(proxy);
            await Task.WhenAll(output, errors);
        }
    }

    private static async Task ReadProxyAsync(StreamReader stream, TaskCompletionSource<Uri>? ready, string token, string secret)
    {
        try
        {
            while (await stream.ReadLineAsync() is { } line)
            {
                if (ready is not null && line.StartsWith("{\"event\":\"claudecode-proxy-ready\"", StringComparison.Ordinal))
                {
                    using var document = JsonDocument.Parse(line);
                    var url = new Uri(document.RootElement.GetProperty("url").GetString()!);
                    if (url.Scheme != "http" || url.Host != "127.0.0.1" || url.Port <= 0
                        || url.UserInfo.Length != 0 || url.AbsolutePath != "/" || url.Query.Length != 0 || url.Fragment.Length != 0)
                        throw new InvalidOperationException("The proxy returned an invalid loopback address.");
                    ready.TrySetResult(url);
                }
                else Console.Error.WriteLine("[claudecode-proxy] " + line.Replace(token, "[redacted]").Replace(secret, "[redacted]"));
            }
            ready?.TrySetException(new InvalidOperationException("The local Copilot proxy exited before becoming ready."));
        }
        catch (Exception error)
        {
            ready?.TrySetException(error);
            throw;
        }
    }
}
