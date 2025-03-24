const esbuild = require("esbuild")
const fs = require("fs")
const path = require("path")

const production = process.argv.includes("--production")
const watch = process.argv.includes("--watch")

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started")
    })
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`)
        console.error(
          `    ${location.file}:${location.line}:${location.column}:`,
        )
      })
      console.log("[watch] build finished")
    })
  },
}

/**
 * @type {import('esbuild').Plugin}
 */
const copyWordlistPlugin = {
  name: "copy-wordlist",

  setup(build) {
    build.onEnd(() => {
      // Source path for wordlist.json
      const srcPath = path.join(__dirname, "src", "wordlist.json")
      // Destination path in dist directory
      const destPath = path.join(__dirname, "dist", "wordlist.json")

      try {
        // Check if source file exists
        if (fs.existsSync(srcPath)) {
          // Create the dist directory if it doesn't exist
          if (!fs.existsSync(path.dirname(destPath))) {
            fs.mkdirSync(path.dirname(destPath), { recursive: true })
          }

          // Copy file from src to dist
          fs.copyFileSync(srcPath, destPath)
          console.log(`✓ [SUCCESS] Copied wordlist.json to dist directory`)
        } else {
          console.error(`✘ [ERROR] Could not find src/wordlist.json file`)
        }
      } catch (error) {
        console.error(
          `✘ [ERROR] Failed to copy wordlist.json: ${error.message}`,
        )
      }
    })
  },
}

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "silent",
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
      copyWordlistPlugin,
    ],
  })
  if (watch) {
    await ctx.watch()
  } else {
    await ctx.rebuild()
    await ctx.dispose()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
