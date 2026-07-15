const fs = require("fs");
const { spawn } = require("child_process");
const path = require("path");

const { ensureSafeWorkdir } = require("./safe-workdir.cjs");

const projectRoot = path.resolve(__dirname, "..");
const safeCwd = ensureSafeWorkdir(projectRoot);
const nextBin = path.join(safeCwd, "node_modules", "next", "dist", "bin", "next");
const command = process.argv[2];
const proxyEnvKeys = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"];

function unquoteEnvValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadProxyEnvFromDotenv() {
  const envPath = path.join(projectRoot, ".env");
  if (!fs.existsSync(envPath)) return;

  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;

    const key = match[1];
    if (!proxyEnvKeys.includes(key) || process.env[key]) continue;

    const value = unquoteEnvValue(match[2]);
    if (value) {
      process.env[key] = value;
    }
  }
}

if (command === "dev" || command === "build") {
  const nextCacheDir = path.join(
    safeCwd,
    command === "dev" ? ".next-dev" : ".next",
  );
  if (fs.existsSync(nextCacheDir)) {
    fs.rmSync(nextCacheDir, { recursive: true, force: true });
  }
}

loadProxyEnvFromDotenv();

const nodeArgs = [];
if (process.allowedNodeEnvironmentFlags?.has("--use-env-proxy")) {
  nodeArgs.push("--use-env-proxy");
}

const child = spawn(process.execPath, [...nodeArgs, nextBin, ...process.argv.slice(2)], {
  cwd: safeCwd,
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
