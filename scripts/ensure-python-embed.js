// @ts-check
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const EMBED_DIR = path.join(__dirname, '..', 'resources', 'python-embed')
const pythonExe = process.platform === 'win32'
  ? path.join(EMBED_DIR, 'python.exe')
  : path.join(EMBED_DIR, 'bin', 'python3')

if (fs.existsSync(pythonExe)) {
  process.exit(0)
}

console.log('[ensure-python-embed] Bundled Python missing — downloading…')
execSync('node scripts/download-python-embed.js', { stdio: 'inherit', cwd: path.join(__dirname, '..') })
