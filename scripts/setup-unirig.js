// @ts-check
/**
 * Install UniRig for the built-in unirig workflow node.
 * Targets out/builtin-extensions/unirig (dev) — preserved on sync to userData.
 */
const { execSync, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const extDir = path.join(root, 'out', 'builtin-extensions', 'unirig')
const marker = path.join(extDir, '.unirig-ready')
const venvPy =
  process.platform === 'win32'
    ? path.join(extDir, 'venv', 'Scripts', 'python.exe')
    : path.join(extDir, 'venv', 'bin', 'python3')

function findBootstrapPython() {
  const embed =
    process.platform === 'win32'
      ? path.join(root, 'resources', 'python-embed', 'python.exe')
      : path.join(root, 'resources', 'python-embed', 'bin', 'python3')
  if (fs.existsSync(embed)) return embed

  return process.platform === 'win32' ? 'python' : 'python3'
}

function detectCudaVersion() {
  try {
    const out = execSync('nvidia-smi --query-gpu=driver_version --format=csv,noheader', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const major = parseInt(String(out).trim().split('.')[0], 10)
    if (major >= 570) return 128
    if (major >= 560) return 126
    if (major >= 550) return 124
    if (major >= 530) return 121
    if (major >= 520) return 118
    return 118
  } catch {
    return 118
  }
}

if (!fs.existsSync(path.join(extDir, 'setup.py'))) {
  console.error('[setup-unirig] Built-in unirig extension missing. Run: npm run build')
  process.exit(1)
}

if (fs.existsSync(marker) && fs.existsSync(venvPy)) {
  console.log('[setup-unirig] UniRig already installed.')
  process.exit(0)
}

// Retry after a failed install: remove broken venv (keep UniRig clone)
if (fs.existsSync(venvPy) && !fs.existsSync(marker)) {
  console.log('[setup-unirig] Removing incomplete venv from previous attempt…')
  fs.rmSync(path.join(extDir, 'venv'), { recursive: true, force: true })
}

console.log('[setup-unirig] Installing UniRig (GPU + PyTorch). This may take 15–30 minutes…')

const bootstrap = findBootstrapPython()
const cudaVersion = detectCudaVersion()
const setupArgs = JSON.stringify({
  python_exe: bootstrap,
  ext_dir: extDir,
  gpu_sm: 86,
  cuda_version: cudaVersion,
})

const proc = spawnSync(bootstrap, [path.join(extDir, 'setup.py'), setupArgs], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
})

if (proc.status !== 0) {
  process.exit(proc.status ?? 1)
}

console.log('[setup-unirig] Done.')
