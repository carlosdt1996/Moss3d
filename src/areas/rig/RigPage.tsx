import { useCallback, useEffect } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { useApi } from '@shared/hooks/useApi'
import { useRigStore } from './rigStore'
import RigViewer from './components/RigViewer'
import BoneHierarchyPanel from './components/BoneHierarchyPanel'
import { exportRiggedGlb, arrayBufferToBase64 } from './exportRigGlb'

export default function RigPage(): JSX.Element {
  const currentJob = useAppStore((s) => s.currentJob)
  const meshUrl = useRigStore((s) => s.meshUrl)
  const meshLabel = useRigStore((s) => s.meshLabel)
  const bones = useRigStore((s) => s.bones)
  const sceneRef = useRigStore((s) => s.sceneRef)
  const setMesh = useRigStore((s) => s.setMesh)
  const { importMesh } = useApi()

  useEffect(() => {
    if (meshUrl) return
    if (currentJob?.status === 'done' && currentJob.outputUrl) {
      const name = currentJob.outputUrl.split('/').pop() ?? 'model.glb'
      setMesh(currentJob.outputUrl, name)
    }
  }, [currentJob, meshUrl, setMesh])

  const handleImport = useCallback(async () => {
    const filePath = await window.electron.fs.selectMeshFile()
    if (!filePath) return
    try {
      const data = await importMesh(filePath)
      const label = filePath.split(/[\\/]/).pop() ?? 'mesh.glb'
      setMesh(data.url, label)
    } catch (err) {
      console.error('[Rig] import failed', err)
    }
  }, [importMesh, setMesh])

  const handleExport = useCallback(async () => {
    if (!sceneRef || !bones.length) return
    const defaultName = (meshLabel ?? 'rig').replace(/\.\w+$/, '') + '-rig.glb'
    const savePath = await window.electron.fs.savePath({
      defaultPath: defaultName,
      filters: [{ name: 'GLB', extensions: ['glb'] }],
    })
    if (!savePath) return
    try {
      const buffer = await exportRiggedGlb(sceneRef, bones)
      const result = await window.electron.fs.writeBinaryFile({
        filePath: savePath,
        base64: arrayBufferToBase64(buffer),
      })
      if (!result.success) console.error('[Rig] export failed', result.error)
    } catch (err) {
      console.error('[Rig] export failed', err)
    }
  }, [sceneRef, bones, meshLabel])

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-accent/15 bg-surface-500 shrink-0">
        <h1 className="text-sm font-semibold text-zinc-200 mr-2">Rig</h1>
        <button
          type="button"
          onClick={handleImport}
          className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
        >
          Import mesh
        </button>
        <button
          type="button"
          onClick={handleExport}
          disabled={!sceneRef || !bones.length}
          className="text-xs px-3 py-1.5 rounded-lg bg-accent/30 hover:bg-accent/45 text-accent-light disabled:opacity-40"
        >
          Export GLB
        </button>
        {meshLabel && (
          <span className="text-[10px] text-zinc-600 ml-auto truncate max-w-[40%]" title={meshLabel}>
            {meshLabel}
          </span>
        )}
      </header>
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 relative">
          <RigViewer />
        </div>
        <BoneHierarchyPanel />
      </div>
    </div>
  )
}
