import { useAppStore } from '@shared/stores/appStore'
import { Moss3DLogo } from '@shared/components/Moss3DLogo'

export default function TopBar(): JSX.Element {
  const { patchUpdateReady } = useAppStore()

  const handleMinimize = () => window.electron.window.minimize()
  const handleMaximize = () => window.electron.window.maximize()
  const handleClose    = () => window.electron.window.close()

  return (
    <header className="flex items-center h-10 px-4 bg-surface-400 border-b border-accent/20 drag-region shrink-0">
      <div className="flex items-center gap-2 no-drag">
        <Moss3DLogo size={26} gradientId="moss3d-topbar" />
        <span className="text-sm font-semibold text-accent-light tracking-tight">Moss3D</span>
      </div>

      <div className="flex-1" />

      {patchUpdateReady && (
        <div className="flex items-center gap-2 mr-3 px-3 py-1 rounded-full bg-accent/15 border border-accent/30 text-xs text-accent-light no-drag">
          <span>Update ready</span>
          <button
            onClick={() => window.electron.updater.quitAndInstall()}
            className="ml-1 px-2 py-0.5 rounded-full bg-accent hover:bg-accent-dark text-white text-[11px] font-semibold transition-colors"
          >
            Restart
          </button>
        </div>
      )}

      <div className="flex items-center gap-1 no-drag">
        <button
          onClick={handleMinimize}
          className="w-8 h-8 flex items-center justify-center rounded hover:bg-zinc-900 text-zinc-500 hover:text-accent-light transition-colors"
          aria-label="Minimize"
        >
          <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
            <rect width="10" height="1" />
          </svg>
        </button>
        <button
          onClick={handleMaximize}
          className="w-8 h-8 flex items-center justify-center rounded hover:bg-zinc-900 text-zinc-500 hover:text-accent-light transition-colors"
          aria-label="Maximize"
        >
          <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor">
            <rect x="0.5" y="0.5" width="8" height="8" />
          </svg>
        </button>
        <button
          onClick={handleClose}
          className="w-8 h-8 flex items-center justify-center rounded hover:bg-red-600 text-zinc-500 hover:text-white transition-colors"
          aria-label="Close"
        >
          <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.2">
            <line x1="0" y1="0" x2="9" y2="9" />
            <line x1="9" y1="0" x2="0" y2="9" />
          </svg>
        </button>
      </div>
    </header>
  )
}
