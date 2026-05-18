import { Worker }      from 'worker_threads'
import { spawn, execSync } from 'child_process'
import type { ChildProcess } from 'child_process'
import { existsSync }  from 'fs'
import { join }        from 'path'

export const PROCESS_CANCELLED = 'PROCESS_CANCELLED'

export class ProcessCancelledError extends Error {
  constructor() {
    super(PROCESS_CANCELLED)
    this.name = 'ProcessCancelledError'
  }
}

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) {
    try { proc.kill('SIGKILL') } catch { /* ignore */ }
    return
  }
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' })
    } else {
      proc.kill('SIGTERM')
    }
  } catch {
    try { proc.kill('SIGKILL') } catch { /* ignore */ }
  }
}

// ─── Worker code for JS process extensions ────────────────────────────────────

const WORKER_CODE = /* js */ `
const { workerData, parentPort } = require('worker_threads')
const path = require('path')
const Module = require('module')

// Resolve modules from the extension's own node_modules
const require_ext = Module.createRequire(path.join(workerData.extDir, '_'))

let processor
try {
  processor = require_ext(path.join(workerData.extDir, workerData.entry))
  if (typeof processor !== 'function') {
    throw new Error('processor.js must export a function as module.exports')
  }
} catch (err) {
  parentPort.postMessage({ type: 'error', message: 'Failed to load processor: ' + String(err) })
  process.exit(1)
}

parentPort.postMessage({ type: 'ready' })

parentPort.on('message', async (msg) => {
  if (msg.action !== 'run') return
  try {
    const context = {
      workspaceDir: workerData.workspaceDir,
      tempDir:      workerData.tempDir,
      nodeId:       msg.input?.nodeId ?? '',
      log:      (m)         => parentPort.postMessage({ type: 'log',      message: String(m) }),
      progress: (pct, label) => parentPort.postMessage({ type: 'progress', percent: pct, label }),
    }
    const result = await processor(msg.input, msg.params, context)
    parentPort.postMessage({ type: 'done', result })
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: String(err) })
  }
})
`

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProcessInput {
  filePath?: string
  text?:     string
  nodeId?:   string
}

export interface ProcessResult {
  filePath?: string
  text?:     string
}

export interface IProcessRunner {
  run(
    input:       ProcessInput,
    params:      Record<string, unknown>,
    onProgress?: (percent: number, label: string) => void,
    onLog?:      (message: string) => void,
  ): Promise<ProcessResult>
  terminate(): void
  cancelActiveRun(): boolean
}

// ─── JS ProcessRunner (Worker thread) ────────────────────────────────────────

export class ProcessRunner implements IProcessRunner {
  private worker:   Worker | null = null
  private ready:    boolean       = false
  private extDir:   string
  private entry:    string
  private workspaceDir: string
  private tempDir:  string
  private runReject: ((err: Error) => void) | null = null

  constructor(extDir: string, entry: string, workspaceDir: string, tempDir: string) {
    this.extDir       = extDir
    this.entry        = entry
    this.workspaceDir = workspaceDir
    this.tempDir      = tempDir
  }

  private async ensureReady(): Promise<void> {
    if (this.ready && this.worker) return

    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_CODE, {
        eval: true,
        workerData: {
          extDir:       this.extDir,
          entry:        this.entry,
          workspaceDir: this.workspaceDir,
          tempDir:      this.tempDir,
        },
      })

      worker.once('message', (msg) => {
        if (msg.type === 'ready') {
          this.worker = worker
          this.ready  = true
          resolve()
        } else if (msg.type === 'error') {
          worker.terminate()
          reject(new Error(msg.message))
        }
      })

      worker.once('error', (err) => {
        reject(err)
      })
    })
  }

  async run(
    input:  ProcessInput,
    params: Record<string, unknown>,
    onProgress?: (percent: number, label: string) => void,
    onLog?:      (message: string) => void,
  ): Promise<ProcessResult> {
    await this.ensureReady()
    const worker = this.worker!

    return new Promise((resolve, reject) => {
      this.runReject = reject

      const handler = (msg: { type: string; result?: ProcessResult; message?: string; percent?: number; label?: string }) => {
        if (msg.type === 'progress') {
          onProgress?.(msg.percent ?? 0, msg.label ?? '')
        } else if (msg.type === 'log') {
          onLog?.(msg.message ?? '')
        } else if (msg.type === 'done') {
          this.runReject = null
          worker.off('message', handler)
          resolve(msg.result ?? {})
        } else if (msg.type === 'error') {
          this.runReject = null
          worker.off('message', handler)
          reject(new Error(msg.message))
        }
      }

      worker.on('message', handler)
      worker.postMessage({ action: 'run', input, params })
    })
  }

  cancelActiveRun(): boolean {
    if (this.runReject) {
      const reject = this.runReject
      this.runReject = null
      reject(new ProcessCancelledError())
      this.terminate()
      return true
    }
    return false
  }

  terminate(): void {
    this.worker?.terminate()
    this.worker = null
    this.ready  = false
    this.runReject = null
  }
}

// ─── Python ProcessRunner (subprocess, one process per run) ───────────────────
//
// Protocol — stdin:  one JSON line  { input, params, workspaceDir, tempDir }
// Protocol — stdout: JSON lines     { type: 'progress'|'log'|'done'|'error', ... }

export class PythonProcessRunner implements IProcessRunner {
  private pythonExe:    string
  private scriptPath:   string
  private workspaceDir: string
  private tempDir:      string
  private activeProc:   ChildProcess | null = null
  private activeReject: ((err: Error) => void) | null = null
  private cancelled = false

  constructor(pythonExe: string, extDir: string, entry: string, workspaceDir: string, tempDir: string) {
    this.pythonExe    = pythonExe
    this.scriptPath   = join(extDir, entry)
    this.workspaceDir = workspaceDir
    this.tempDir      = tempDir
  }

  async run(
    input:  ProcessInput,
    params: Record<string, unknown>,
    onProgress?: (percent: number, label: string) => void,
    onLog?:      (message: string) => void,
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      this.cancelled = false
      this.activeReject = reject

      const proc = spawn(this.pythonExe, [this.scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
        },
      })
      this.activeProc = proc

      proc.stdin.write(JSON.stringify({
        input,
        params,
        nodeId:       input.nodeId ?? '',
        workspaceDir: this.workspaceDir,
        tempDir:      this.tempDir,
      }) + '\n')
      proc.stdin.end()

      let stdoutBuf = ''
      let resolved  = false
      let lastError: string | null = null

      const finish = (fn: () => void) => {
        if (resolved) return
        resolved = true
        this.activeProc = null
        this.activeReject = null
        fn()
      }

      proc.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString()
        const lines = stdoutBuf.split('\n')
        stdoutBuf = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const msg = JSON.parse(trimmed) as { type: string; percent?: number; label?: string; message?: string; result?: ProcessResult }
            if (msg.type === 'progress') {
              onProgress?.(msg.percent ?? 0, msg.label ?? '')
            } else if (msg.type === 'log') {
              onLog?.(msg.message ?? '')
            } else if (msg.type === 'done') {
              finish(() => resolve(msg.result ?? {}))
            } else if (msg.type === 'error') {
              lastError = msg.message ?? 'Unknown error'
              finish(() => reject(new Error(lastError!)))
            }
          } catch {
            onLog?.(trimmed)
          }
        }
      })

      proc.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        for (const line of text.split('\n')) {
          const trimmed = line.trim()
          if (trimmed) onLog?.(`[stderr] ${trimmed}`)
        }
      })

      proc.on('close', (code) => {
        if (!resolved) {
          if (stdoutBuf.trim()) {
            try {
              const msg = JSON.parse(stdoutBuf.trim()) as { type: string; message?: string; result?: ProcessResult }
              if (msg.type === 'error') {
                lastError = msg.message ?? 'Unknown error'
                finish(() => reject(new Error(lastError!)))
                this.cancelled = false
                return
              } else if (msg.type === 'done') {
                finish(() => resolve(msg.result ?? {}))
                this.cancelled = false
                return
              }
            } catch { /* not valid JSON, ignore */ }
          }
          if (this.cancelled) {
            finish(() => reject(new ProcessCancelledError()))
          } else if (code === 0) {
            finish(() => resolve({}))
          } else {
            const reason = lastError ?? `Python process exited with code ${code}`
            finish(() => reject(new Error(reason)))
          }
        }
        this.cancelled = false
      })

      proc.on('error', (err) => {
        finish(() => {
          if (this.cancelled) reject(new ProcessCancelledError())
          else reject(err)
        })
      })
    })
  }

  cancelActiveRun(): boolean {
    if (!this.activeProc) return false
    this.cancelled = true
    if (this.activeReject) {
      const reject = this.activeReject
      this.activeReject = null
      reject(new ProcessCancelledError())
    }
    killProcessTree(this.activeProc)
    this.activeProc = null
    return true
  }

  terminate(): void {
    this.cancelActiveRun()
  }
}

// ─── Helper: find Python executable for an extension ─────────────────────────

export function getExtPythonExe(extDir: string): string | null {
  const candidates = process.platform === 'win32'
    ? [join(extDir, 'venv', 'Scripts', 'python.exe')]
    : [join(extDir, 'venv', 'bin', 'python'), join(extDir, 'venv', 'bin', 'python3')]

  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

// ─── Registry (one runner per extension id, reused across calls) ──────────────

const registry = new Map<string, IProcessRunner>()

export function getProcessRunner(
  extensionId:  string,
  extDir:       string,
  entry:        string,
  workspaceDir: string,
  tempDir:      string,
): ProcessRunner {
  if (!registry.has(extensionId)) {
    registry.set(extensionId, new ProcessRunner(extDir, entry, workspaceDir, tempDir))
  }
  return registry.get(extensionId)! as ProcessRunner
}

export function getPythonProcessRunner(
  extensionId:  string,
  pythonExe:    string,
  extDir:       string,
  entry:        string,
  workspaceDir: string,
  tempDir:      string,
): PythonProcessRunner {
  if (!registry.has(extensionId)) {
    registry.set(extensionId, new PythonProcessRunner(pythonExe, extDir, entry, workspaceDir, tempDir))
  }
  return registry.get(extensionId)! as PythonProcessRunner
}

export function terminateProcessRunner(extensionId: string): void {
  registry.get(extensionId)?.terminate()
  registry.delete(extensionId)
}

export function terminateAllProcessRunners(): void {
  for (const runner of registry.values()) runner.terminate()
  registry.clear()
}

/** Kill any in-flight process extension run (e.g. HY-Motion / UniRig). */
export function cancelActiveProcessRun(extensionId?: string): boolean {
  let cancelled = false
  for (const [id, runner] of registry) {
    if (extensionId && id !== extensionId) continue
    if (runner.cancelActiveRun()) cancelled = true
  }
  return cancelled
}
