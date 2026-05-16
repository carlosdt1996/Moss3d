import { create } from 'zustand'
import type { RigBone } from './rigTypes'
import {
  addChildBone,
  createDefaultHumanoidRig,
  extractBonesFromScene,
  inferBoneGroup,
  removeBoneWithRebalance,
} from './rigSkeleton'
import * as THREE from 'three'
import type { GltfParserLike } from '@areas/generate/components/SkeletonOverlay'

interface RigState {
  meshUrl: string | null
  meshLabel: string | null
  bones: RigBone[]
  selectedBoneId: string | null
  sceneRef: THREE.Object3D | null

  setMesh: (url: string | null, label?: string | null) => void
  loadFromScene: (scene: THREE.Object3D, parser?: GltfParserLike) => void
  selectBone: (id: string | null) => void
  renameBone: (id: string, name: string) => void
  moveBoneHead: (id: string, head: [number, number, number]) => void
  addBone: (parentId?: string | null) => void
  removeSelectedBone: () => void
  removeBone: (id: string) => void
  setSceneRef: (scene: THREE.Object3D | null) => void
  reset: () => void
}

export const useRigStore = create<RigState>((set, get) => ({
  meshUrl: null,
  meshLabel: null,
  bones: [],
  selectedBoneId: null,
  sceneRef: null,

  setMesh: (url, label = null) =>
    set({
      meshUrl: url,
      meshLabel: label,
      bones: [],
      selectedBoneId: null,
      sceneRef: null,
    }),

  loadFromScene: (scene, parser) => {
    let bones = extractBonesFromScene(scene, parser)
    if (!bones.length) bones = createDefaultHumanoidRig(scene)
    set({ bones, selectedBoneId: bones[0]?.id ?? null })
  },

  selectBone: (id) => set({ selectedBoneId: id }),

  renameBone: (id, name) =>
    set((s) => ({
      bones: s.bones.map((b) =>
        b.id === id ? { ...b, name, group: inferBoneGroup(name) } : b,
      ),
    })),

  moveBoneHead: (id, head) =>
    set((s) => ({
      bones: s.bones.map((b) => {
        if (b.id !== id) return b
        const dx = head[0] - b.head[0]
        const dy = head[1] - b.head[1]
        const dz = head[2] - b.head[2]
        return {
          ...b,
          head,
          tail: [b.tail[0] + dx, b.tail[1] + dy, b.tail[2] + dz],
        }
      }),
    })),

  addBone: (parentId) => {
    const pid = parentId ?? get().selectedBoneId ?? get().bones.find((b) => !b.parentId)?.id ?? null
    const next = addChildBone(get().bones, pid)
    const newId = next[next.length - 1]!.id
    set({ bones: next, selectedBoneId: newId })
  },

  removeSelectedBone: () => {
    const id = get().selectedBoneId
    if (!id) return
    get().removeBone(id)
  },

  removeBone: (id) =>
    set((s) => {
      const bones = removeBoneWithRebalance(s.bones, id)
      const selectedBoneId =
        s.selectedBoneId === id ? (bones[0]?.id ?? null) : s.selectedBoneId
      return { bones, selectedBoneId }
    }),

  setSceneRef: (scene) => set({ sceneRef: scene }),

  reset: () =>
    set({
      meshUrl: null,
      meshLabel: null,
      bones: [],
      selectedBoneId: null,
      sceneRef: null,
    }),
}))
