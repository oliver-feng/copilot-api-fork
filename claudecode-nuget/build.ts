import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const output = resolve(root, "claudecode-nuget", "payload")
await mkdir(output, { recursive: true })
const result = await Bun.build({
  entrypoints: [resolve(root, "claudecode-shim", "proxy-main.ts")],
  outdir: output,
  naming: "proxy.mjs",
  target: "node",
  format: "esm",
  minify: true,
})
if (!result.success)
  throw new AggregateError(
    result.logs,
    "The contained proxy could not be built",
  )
