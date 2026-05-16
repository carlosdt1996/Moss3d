import { useEffect, useMemo, useState } from 'react'
import { useRigStore } from '../rigStore'
import { buildBoneTree } from '../rigSkeleton'
import type { RigBoneTreeNode } from '../rigTypes'

function BoneTreeRow({
  node,
  depth,
  selectedId,
  collapsed,
  onToggle,
  onSelect,
  onRename,
}: {
  node: RigBoneTreeNode
  depth: number
  selectedId: string | null
  collapsed: Set<string>
  onToggle: (id: string) => void
  onSelect: (id: string) => void
  onRename: (id: string, name: string) => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(node.name)
  const isCollapsed = collapsed.has(node.id)
  const hasChildren = node.children.length > 0
  const selected = node.id === selectedId

  return (
    <div>
      <div
        className={`flex items-center gap-1 py-1 pr-2 rounded cursor-pointer text-xs ${
          selected ? 'bg-accent/25 text-accent-light' : 'text-zinc-400 hover:bg-zinc-800/80'
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => onSelect(node.id)}
      >
        {hasChildren ? (
          <button
            type="button"
            className="w-4 h-4 flex items-center justify-center text-zinc-500 hover:text-zinc-300"
            onClick={(e) => {
              e.stopPropagation()
              onToggle(node.id)
            }}
          >
            {isCollapsed ? '▸' : '▾'}
          </button>
        ) : (
          <span className="w-4 inline-block" />
        )}
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              onRename(node.id, draft.trim() || node.name)
              setEditing(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onRename(node.id, draft.trim() || node.name)
                setEditing(false)
              }
              if (e.key === 'Escape') {
                setDraft(node.name)
                setEditing(false)
              }
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 bg-zinc-900 border border-zinc-600 rounded px-1 py-0.5 text-zinc-200"
          />
        ) : (
          <span
            className="flex-1 truncate"
            onDoubleClick={(e) => {
              e.stopPropagation()
              setDraft(node.name)
              setEditing(true)
            }}
          >
            {node.name}
          </span>
        )}
      </div>
      {hasChildren && !isCollapsed &&
        node.children.map((child) => (
          <BoneTreeRow
            key={child.id}
            node={child}
            depth={depth + 1}
            selectedId={selectedId}
            collapsed={collapsed}
            onToggle={onToggle}
            onSelect={onSelect}
            onRename={onRename}
          />
        ))}
    </div>
  )
}

export default function BoneHierarchyPanel(): JSX.Element {
  const bones = useRigStore((s) => s.bones)
  const selectedBoneId = useRigStore((s) => s.selectedBoneId)
  const selectBone = useRigStore((s) => s.selectBone)
  const renameBone = useRigStore((s) => s.renameBone)
  const addBone = useRigStore((s) => s.addBone)
  const removeSelectedBone = useRigStore((s) => s.removeSelectedBone)

  const tree = useMemo(() => buildBoneTree(bones), [bones])
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const structureKey = useMemo(() => bones.map((b) => b.id).join('|'), [bones])

  useEffect(() => {
    setCollapsed(new Set(bones.map((b) => b.id)))
  }, [structureKey, bones])

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <aside className="flex flex-col w-72 shrink-0 border-l border-accent/15 bg-surface-500">
      <div className="px-3 py-2 border-b border-zinc-800 flex items-center justify-between">
        <h2 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Skeleton</h2>
        <span className="text-[10px] text-zinc-600">{bones.length} bones</span>
      </div>
      <div className="flex gap-1 p-2 border-b border-zinc-800">
        <button
          type="button"
          onClick={() => addBone()}
          className="flex-1 text-[10px] py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
        >
          + Add bone
        </button>
        <button
          type="button"
          onClick={removeSelectedBone}
          disabled={!selectedBoneId}
          className="flex-1 text-[10px] py-1.5 rounded bg-zinc-800 hover:bg-red-900/50 text-zinc-300 disabled:opacity-40"
        >
          Remove
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-1">
        {tree.length === 0 ? (
          <p className="text-[11px] text-zinc-600 px-2 py-4">No bones. Add one or load a rigged model.</p>
        ) : (
          tree.map((node) => (
            <BoneTreeRow
              key={node.id}
              node={node}
              depth={0}
              selectedId={selectedBoneId}
              collapsed={collapsed}
              onToggle={toggle}
              onSelect={selectBone}
              onRename={renameBone}
            />
          ))
        )}
      </div>
      <div className="px-3 py-2 border-t border-zinc-800 text-[10px] text-zinc-600">
        Click a joint in the viewport. Double-click a name to rename.
      </div>
    </aside>
  )
}

