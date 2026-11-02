import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const fixtures: Array<string> = []
const projects = {
  claude: ["claudecode-nuget", "claudecode-contained-launcher"],
  copilot: ["copilotcli-nuget", "copilot-contained-launcher"],
} as const

const proxySource = `
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const server = http.createServer((request, response) => {
  response.statusCode = request.headers.authorization === "Bearer " + process.env.CLAUDECODE_PROXY_AUTH_TOKEN ? 200 : 401;
  response.end("fixture");
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  fs.writeFileSync(path.join(process.env.HOME, "proxy.json"), JSON.stringify({
    pid: process.pid, port, tokenProvided: process.env.COPILOT_GITHUB_TOKEN === "fixture-token"
  }));
  console.log(JSON.stringify({event: "claudecode-proxy-ready", url: "http://127.0.0.1:" + port + "/"}));
});
`

const cliSource = `
import fs from "node:fs";
fs.writeFileSync(process.env.FAKE_STARTED, String(process.pid));
if (process.env.FAKE_HOLD === "1") await new Promise(resolve => setTimeout(resolve, 5000));
let proxyStatus;
if (process.env.ANTHROPIC_BASE_URL) {
  const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
    headers: {authorization: "Bearer " + process.env.ANTHROPIC_AUTH_TOKEN}
  });
  proxyStatus = response.status;
}
console.log(JSON.stringify({
  args: process.argv.slice(2), proxyStatus,
  github: process.env.GH_TOKEN === "fixture-token",
  copilot: process.env.COPILOT_GITHUB_TOKEN === "fixture-token",
  leakedGitHub: Boolean(process.env.GITHUB_TOKEN || process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN),
  leakedAnthropic: Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN),
  bedrock: process.env.CLAUDE_CODE_USE_BEDROCK,
  model: process.env.ANTHROPIC_MODEL,
  updatesDisabled: process.env.DISABLE_UPDATES === "1" && process.env.DISABLE_AUTOUPDATER === "1"
}));
process.exit(Number(process.env.FAKE_EXIT ?? "0"));
`

describe.skipIf(process.platform === "win32")(
  "contained Linux launchers",
  () => {
    beforeAll(buildPackages, 120_000)

    afterEach(async () => {
      for (const directory of fixtures.splice(0))
        await rm(directory, { recursive: true, force: true })
    })

    test("Claude uses its private proxy, isolates credentials, forwards arguments, and preserves exit codes", async () => {
      const fixture = await prepare("claude")
      const child = launch(
        fixture,
        ["--prompt", "a 'quoted' prompt with $()"],
        { FAKE_EXIT: "17" },
      )
      const result = await collect(child)
      expect(result.code).toBe(17)
      const payload = JSON.parse(result.stdout) as Record<string, unknown>
      expect(payload.args).toEqual(["--prompt", "a 'quoted' prompt with $()"])
      expect(payload.proxyStatus).toBe(200)
      expect(payload.leakedGitHub).toBe(false)
      expect(payload.leakedAnthropic).toBe(false)
      expect(payload.bedrock).toBeUndefined()
      expect(payload.model).toBe("fixture-model")
      expect(payload.updatesDisabled).toBe(true)
      const proxy = JSON.parse(
        await readFile(join(fixture.directory, "proxy.json"), "utf8"),
      ) as { pid: number; tokenProvided: boolean }
      expect(proxy.tokenProvided).toBe(true)
      expect(() => process.kill(proxy.pid, 0)).toThrow()
      expect(result.stderr).not.toContain("fixture-token")
    })

    test("Copilot launches directly using only the explicitly supplied token", async () => {
      const fixture = await prepare("copilot")
      const result = await collect(
        launch(fixture, ["--prompt", "hello"], { FAKE_EXIT: "9" }),
      )
      expect(result.code).toBe(9)
      const payload = JSON.parse(result.stdout) as Record<string, unknown>
      expect(payload.args).toEqual(["--prompt", "hello"])
      expect(payload.github).toBe(true)
      expect(payload.copilot).toBe(true)
      expect(payload.proxyStatus).toBeUndefined()
      expect(result.stderr).not.toContain("fixture-token")
    })

    test.each(["claude", "copilot"] as const)(
      "%s allows version queries without credentials",
      async (kind) => {
        const fixture = await prepare(kind)
        const result = await collect(
          launch(fixture, ["--version"], { COPILOT_GITHUB_TOKEN: undefined }),
        )
        expect(result.code).toBe(0)
        expect(result.stdout.trim()).toBe(fixture.versionOutput)
      },
    )

    test.each(["claude", "copilot"] as const)(
      "%s NuGet installs cleanly and launches its packaged entry point",
      async (kind) => {
        const fixture = await prepare(kind)
        const installed = await installPackage(fixture, kind)
        const assemblies = await Array.fromAsync(
          new Bun.Glob(`**/${fixture.assembly}.dll`).scan({
            cwd: join(installed, ".store"),
            absolute: true,
          }),
        )
        expect(assemblies).toHaveLength(1)
        fixture.entrypoint = assemblies[0]
        const result = await collect(
          launch(fixture, ["--version"], {
            COPILOT_GITHUB_TOKEN: undefined,
            ANTHROPIC_MODEL: undefined,
          }),
        )
        expect(result.code).toBe(0)
        expect(result.stdout.trim()).toBe(fixture.versionOutput)
      },
      60_000,
    )

    test.each(["claude", "copilot"] as const)(
      "%s fails explicitly when runtime credentials are absent",
      async (kind) => {
        const fixture = await prepare(kind)
        const result = await collect(
          launch(fixture, [], { COPILOT_GITHUB_TOKEN: undefined }),
        )
        expect(result.code).toBe(1)
        expect(result.stderr).toContain("COPILOT_GITHUB_TOKEN must be supplied")
      },
    )

    test("Claude requires an explicit model and the prepared version", async () => {
      const fixture = await prepare("claude")
      let result = await collect(
        launch(fixture, [], { ANTHROPIC_MODEL: undefined }),
      )
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("ANTHROPIC_MODEL must be supplied")
      await writeFile(
        fixture.executable,
        "#!/bin/bash\necho '2.1.303 (Claude Code)'\n",
      )
      result = await collect(launch(fixture, []))
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("version mismatch")
    })

    test.each(["claude", "copilot"] as const)(
      "%s requires the host-provided path and version",
      async (kind) => {
        const fixture = await prepare(kind)
        const prefix = kind === "claude" ? "CLAUDE_CODE" : "COPILOT_CLI"
        const missingPath = await collect(
          launch(fixture, ["--version"], { [`${prefix}_PATH`]: undefined }),
        )
        expect(missingPath.code).toBe(1)
        expect(missingPath.stderr).toContain(`${prefix}_PATH must point`)
        const missingVersion = await collect(
          launch(fixture, ["--version"], { [`${prefix}_VERSION`]: undefined }),
        )
        expect(missingVersion.code).toBe(1)
        expect(missingVersion.stderr).toContain(
          `${prefix}_VERSION must be supplied`,
        )
      },
    )

    test.each(["claude", "copilot"] as const)(
      "%s follows the host-selected version rather than a compiled pin",
      async (kind) => {
        const fixture = await prepare(kind)
        const prefix = kind === "claude" ? "CLAUDE_CODE" : "COPILOT_CLI"
        const version = "9.8.7"
        const versionOutput =
          kind === "claude" ?
            `${version} (Claude Code)`
          : `GitHub Copilot CLI ${version}.`
        await writeFile(
          fixture.executable,
          `#!/bin/bash\necho '${versionOutput}'\n`,
        )
        const result = await collect(
          launch(fixture, ["--version"], { [`${prefix}_VERSION`]: version }),
        )
        expect(result.code).toBe(0)
        expect(result.stdout.trim()).toBe(versionOutput)
      },
    )

    test("Copilot rejects a mismatched prepared version before using credentials", async () => {
      const fixture = await prepare("copilot")
      const result = await collect(
        launch(fixture, [], { COPILOT_CLI_VERSION: "0.0.0" }),
      )
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("version mismatch")
    })

    test("a failed proxy stops the running CLI", async () => {
      const fixture = await prepare("claude")
      await writeFile(
        join(fixture.directory, "payload", "proxy.mjs"),
        proxySource + "\nsetTimeout(() => process.exit(42), 400);\n",
      )
      const result = await collect(launch(fixture, [], { FAKE_HOLD: "1" }))
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(
        "proxy exited while Claude Code was running",
      )
      const pid = Number(
        await readFile(join(fixture.directory, "cli.pid"), "utf8"),
      )
      expect(() => process.kill(pid, 0)).toThrow()
    })

    test("SIGTERM stops both the CLI and its proxy", async () => {
      const fixture = await prepare("claude")
      const child = launch(fixture, [], { FAKE_HOLD: "1" })
      const completion = collect(child)
      await waitForFile(join(fixture.directory, "cli.pid"))
      child.kill("SIGTERM")
      const result = await completion
      expect(result.code).toBe(143)
      const pid = Number(
        await readFile(join(fixture.directory, "cli.pid"), "utf8"),
      )
      const proxy = JSON.parse(
        await readFile(join(fixture.directory, "proxy.json"), "utf8"),
      ) as { pid: number }
      expect(() => process.kill(pid, 0)).toThrow()
      expect(() => process.kill(proxy.pid, 0)).toThrow()
    })
  },
)

function buildPackages(): void {
  run([process.execPath, "run", "build:contained"])
  for (const [directory] of Object.values(projects)) {
    run([
      "dotnet",
      "pack",
      join(
        directory,
        directory === "claudecode-nuget" ?
          "ClaudeCode.Contained.csproj"
        : "CopilotCli.Contained.csproj",
      ),
      "-c",
      "Release",
      "-o",
      join(root, ".artifacts", "nuget"),
      "--verbosity",
      "quiet",
    ])
  }
}

function run(command: Array<string>, env = process.env): void {
  const result = Bun.spawnSync(command, {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  if (result.exitCode !== 0)
    throw new Error(
      `${command.join(" ")} failed:\n${result.stdout.toString()}\n${result.stderr.toString()}`,
    )
}

async function installPackage(
  fixture: Awaited<ReturnType<typeof prepare>>,
  kind: keyof typeof projects,
) {
  const packageId =
    kind === "claude" ? "ClaudeCode.Contained" : "CopilotCli.Contained"
  const config = join(fixture.directory, "nuget.config")
  await writeFile(
    config,
    "<configuration><packageSources><clear /></packageSources></configuration>",
  )
  const installed = join(fixture.directory, "installed")
  run(
    [
      "dotnet",
      "tool",
      "install",
      packageId,
      "--version",
      "2.1.0",
      "--tool-path",
      installed,
      "--configfile",
      config,
      "--add-source",
      join(root, ".artifacts", "nuget"),
    ],
    {
      ...process.env,
      NUGET_PACKAGES: join(fixture.directory, "nuget-cache"),
      DOTNET_CLI_HOME: fixture.directory,
    },
  )
  return installed
}

async function prepare(kind: keyof typeof projects) {
  const directory = await mkdtemp(join(tmpdir(), "contained-shim-"))
  fixtures.push(directory)
  const [project, assembly] = projects[kind]
  for (const extension of [".dll", ".runtimeconfig.json"])
    await copyFile(
      join(root, project, "bin", "Release", "net8.0", assembly + extension),
      join(directory, assembly + extension),
    )
  await mkdir(join(directory, "payload"))
  await writeFile(join(directory, "payload", "proxy.mjs"), proxySource)
  await writeFile(join(directory, "cli.mjs"), cliSource)
  const executable = join(directory, "prepared-cli")
  const versionOutput =
    kind === "claude" ? "2.1.302 (Claude Code)" : "GitHub Copilot CLI 1.0.105."
  await writeFile(
    executable,
    `#!/bin/bash
if [ "$1" = "--version" ]; then echo "${versionOutput}"; exit 0; fi
exec node "$FAKE_CLI_SOURCE" "$@"
`,
  )
  await chmod(executable, 0o755)
  return {
    directory,
    assembly,
    executable,
    versionOutput,
    entrypoint: join(directory, assembly + ".dll"),
  }
}

function launch(
  fixture: Awaited<ReturnType<typeof prepare>>,
  args: Array<string>,
  overrides: NodeJS.ProcessEnv = {},
) {
  return Bun.spawn(["dotnet", fixture.entrypoint, ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: fixture.directory,
      CLAUDE_CODE_PATH: fixture.executable,
      CLAUDE_CODE_VERSION: "2.1.302",
      COPILOT_CLI_PATH: fixture.executable,
      COPILOT_CLI_VERSION: "1.0.105",
      COPILOT_GITHUB_TOKEN: "fixture-token",
      GH_TOKEN: "conflicting-fixture-token",
      GITHUB_TOKEN: "conflicting-fixture-token",
      ANTHROPIC_API_KEY: "conflicting-fixture-token",
      CLAUDE_CODE_OAUTH_TOKEN: "conflicting-fixture-token",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_MODEL: "fixture-model",
      FAKE_CLI_SOURCE: join(fixture.directory, "cli.mjs"),
      FAKE_STARTED: join(fixture.directory, "cli.pid"),
      ...overrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function collect(child: ReturnType<typeof launch>) {
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

async function waitForFile(path: string) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (await Bun.file(path).exists()) return
    await Bun.sleep(20)
  }
  throw new Error("The fixture CLI did not start")
}
