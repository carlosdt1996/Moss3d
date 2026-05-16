import { join } from 'path'
import { existsSync } from 'fs'
import { app } from 'electron'
import { getBuiltinExtensionsDir } from './builtin-sync'
import { getVenvPythonExe } from './python-setup'
import { logger } from './logger'
import { spawn } from 'child_process'

function runExtensionSetupPy(extDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const setupPy = join(extDir, 'setup.py')
    if (!existsSync(setupPy)) {
      resolve()
      return
    }

    const marker = join(extDir, '.unirig-ready')
    const venvPy =
      process.platform === 'win32'
        ? join(extDir, 'venv', 'Scripts', 'python.exe')
        : join(extDir, 'venv', 'bin', 'python3')

    if (existsSync(marker) && existsSync(venvPy)) {
      resolve()
      return
    }

    const userData = app.getPath('userData')
    const pythonExe = getVenvPythonExe(userData)
    const args = JSON.stringify({
      python_exe: pythonExe,
      ext_dir: extDir,
      gpu_sm: 86,
      cuda_version: 118,
    })

    logger.info(`[builtin-setup] Running setup for ${extDir}`)
    const proc = spawn(pythonExe, [setupPy, args], { stdio: ['ignore', 'pipe', 'pipe'] })

    proc.stdout?.on('data', (d: Buffer) => {
      d.toString().split('\n').forEach((line) => {
        if (line.trim()) logger.info(`[builtin-setup] ${line.trim()}`)
      })
    })
    proc.stderr?.on('data', (d: Buffer) => {
      d.toString().split('\n').forEach((line) => {
        if (line.trim()) logger.warn(`[builtin-setup] ${line.trim()}`)
      })
    })

    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`setup.py exited with code ${code}`))
    })
    proc.on('error', reject)
  })
}

/**
 * Ensure built-in extensions with heavy install dirs are not wiped on sync.
 */
export async function setupBuiltinExtensionsIfNeeded(): Promise<void> {
  const extDir = join(getBuiltinExtensionsDir(), 'unirig')
  if (!existsSync(join(extDir, 'manifest.json'))) return

  try {
    await runExtensionSetupPy(extDir)
  } catch (err) {
    logger.warn(`[builtin-setup] UniRig setup skipped/failed: ${String(err)}`)
  }
}
