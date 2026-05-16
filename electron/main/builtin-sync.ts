import { join } from 'path'
import { app } from 'electron'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { logger } from './logger'

const PRESERVE_DIRS = new Set(['venv', 'UniRig', 'node_modules'])

export function getBuiltinExtensionsDir(): string {
  return join(app.getPath('userData'), 'builtin-extensions')
}

function getBuiltinResourcesDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'builtin-extensions')
  }
  return join(__dirname, '../../out/builtin-extensions')
}

/**
 * Sync built-in extensions from app resources to userData/builtin-extensions.
 * Preserves heavy install folders (venv, UniRig clone, node_modules) per extension.
 */
export function syncBuiltinExtensions(): void {
  const resourcesDir = getBuiltinResourcesDir()

  if (!existsSync(resourcesDir)) {
    logger.info('[builtin-sync] No built-in extensions resources found, skipping.')
    return
  }

  const destRoot = getBuiltinExtensionsDir()
  mkdirSync(destRoot, { recursive: true })

  for (const id of readdirSync(resourcesDir)) {
    const srcDir = join(resourcesDir, id)
    if (!statSync(srcDir).isDirectory()) continue
    if (!existsSync(join(srcDir, 'manifest.json'))) continue

    const destDir = join(destRoot, id)
    mkdirSync(destDir, { recursive: true })

    for (const name of readdirSync(srcDir)) {
      if (PRESERVE_DIRS.has(name) && existsSync(join(destDir, name))) {
        continue
      }
      const from = join(srcDir, name)
      const to = join(destDir, name)
      if (existsSync(to)) {
        rmSync(to, { recursive: true, force: true })
      }
      cpSync(from, to, { recursive: true })
    }
  }

  // Remove extensions dropped from the app bundle
  for (const id of readdirSync(destRoot)) {
    const destDir = join(destRoot, id)
    if (!statSync(destDir).isDirectory()) continue
    if (!existsSync(join(resourcesDir, id))) {
      rmSync(destDir, { recursive: true, force: true })
    }
  }

  logger.info(`[builtin-sync] Built-in extensions synced to ${destRoot}`)
}
