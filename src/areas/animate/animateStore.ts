import { create } from 'zustand'
import * as THREE from 'three'
import type { AnimationClip, AnimationTrack, Keyframe, KeyframeSelection } from './animateTypes'
import type { RigBone } from '@areas/rig/rigTypes'

let _nextClipId = 0
function freshClipId(): string {
  _nextClipId++
  return `clip-${_nextClipId}-${Date.now()}`
}

function cloneKeyframes(kfs: Keyframe[]): Keyframe[] {
  return kfs.map((k) => ({ ...k }))
}

function cloneTracks(tracks: AnimationTrack[]): AnimationTrack[] {
  return tracks.map((t) => ({ ...t, keyframes: cloneKeyframes(t.keyframes) }))
}

function ensureTracksForBones(
  tracks: AnimationTrack[],
  bones: RigBone[],
): AnimationTrack[] {
  const existing = new Set(tracks.map((t) => t.boneId))
  const appended = [...tracks]
  for (const b of bones) {
    if (!existing.has(b.id)) {
      appended.push({ boneId: b.id, boneName: b.name, keyframes: [] })
    }
  }
  return appended
}

function pruneOrphanedTracks(
  tracks: AnimationTrack[],
  bones: RigBone[],
): AnimationTrack[] {
  const boneIds = new Set(bones.map((b) => b.id))
  return tracks.filter((t) => boneIds.has(t.boneId))
}

interface AnimateState {
  clips: AnimationClip[]
  activeClipId: string | null
  playing: boolean
  loop: boolean
  playbackSpeed: number
  currentTime: number
  meshUrl: string | null
  meshLabel: string | null
  bones: RigBone[]
  selectedBoneId: string | null
  selectedKeyframe: KeyframeSelection | null
  sceneRef: THREE.Object3D | null

  setMesh: (url: string | null, label?: string | null) => void
  setBones: (bones: RigBone[]) => void
  setSceneRef: (scene: THREE.Object3D | null) => void

  createClip: (name: string) => void
  renameClip: (clipId: string, name: string) => void
  deleteClip: (clipId: string) => void
  duplicateClip: (clipId: string) => void
  setActiveClip: (clipId: string | null) => void

  addKeyframe: (boneId: string, time: number, pose: { position?: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number] }) => void
  removeKeyframe: (boneId: string, keyframeIndex: number) => void
  updateKeyframeTime: (boneId: string, keyframeIndex: number, time: number) => void
  updateKeyframeValue: (boneId: string, keyframeIndex: number, field: 'position' | 'rotation' | 'scale', value: [number, number, number]) => void
  moveKeyframeTime: (boneId: string, keyframeIndex: number, deltaTime: number) => void

  setPlaying: (playing: boolean) => void
  setLoop: (loop: boolean) => void
  setPlaybackSpeed: (speed: number) => void
  setCurrentTime: (time: number) => void

  selectBone: (boneId: string | null) => void
  selectKeyframe: (selection: KeyframeSelection | null) => void

  setClipDuration: (clipId: string, duration: number) => void
  reset: () => void
}

export const useAnimateStore = create<AnimateState>((set, get) => ({
  clips: [],
  activeClipId: null,
  playing: false,
  loop: true,
  playbackSpeed: 1,
  currentTime: 0,
  meshUrl: null,
  meshLabel: null,
  bones: [],
  selectedBoneId: null,
  selectedKeyframe: null,
  sceneRef: null,

  setMesh: (url, label = null) =>
    set({
      meshUrl: url,
      meshLabel: label ?? url?.split('/').pop()?.split('\\').pop() ?? 'mesh.glb',
      bones: [],
      selectedBoneId: null,
      selectedKeyframe: null,
      currentTime: 0,
      playing: false,
      clips: [],
      activeClipId: null,
      sceneRef: null,
    }),

  setBones: (bones) =>
    set((s) => {
      const updatedClips = s.clips.map((c) => ({
        ...c,
        tracks: pruneOrphanedTracks(ensureTracksForBones(c.tracks, bones), bones),
      }))
      return {
        bones,
        clips: updatedClips,
        selectedBoneId: bones.length > 0 && !s.selectedBoneId ? bones[0].id : s.selectedBoneId,
      }
    }),

  setSceneRef: (scene) => set({ sceneRef: scene }),

  createClip: (name) =>
    set((s) => {
      const id = freshClipId()
      const tracks = ensureTracksForBones([], s.bones)
      const clip: AnimationClip = { id, name, duration: 2, loop: true, tracks }
      return { clips: [...s.clips, clip], activeClipId: id }
    }),

  renameClip: (clipId, name) =>
    set((s) => ({
      clips: s.clips.map((c) => (c.id === clipId ? { ...c, name } : c)),
    })),

  deleteClip: (clipId) =>
    set((s) => {
      const next = s.clips.filter((c) => c.id !== clipId)
      const activeId = s.activeClipId === clipId ? (next[0]?.id ?? null) : s.activeClipId
      return { clips: next, activeClipId: activeId }
    }),

  duplicateClip: (clipId) =>
    set((s) => {
      const src = s.clips.find((c) => c.id === clipId)
      if (!src) return s
      const id = freshClipId()
      const clone: AnimationClip = {
        id,
        name: `${src.name} (copy)`,
        duration: src.duration,
        loop: src.loop,
        tracks: cloneTracks(src.tracks),
      }
      return { clips: [...s.clips, clone], activeClipId: id }
    }),

  setActiveClip: (clipId) => set({ activeClipId: clipId, currentTime: 0, playing: false }),

  addKeyframe: (boneId, time, pose) =>
    set((s) => {
      if (!s.activeClipId) return s
      const clips = s.clips.map((c) => {
        if (c.id !== s.activeClipId) return c
        const tracks = c.tracks.map((t) => {
          if (t.boneId !== boneId) return t
          const exists = t.keyframes.find((k) => Math.abs(k.time - time) < 0.001)
          if (exists) return t
          const kf: Keyframe = {
            time: Math.round(time * 1000) / 1000,
            position: pose.position ? [...pose.position] as [number, number, number] : undefined,
            rotation: pose.rotation ? [...pose.rotation] as [number, number, number] : undefined,
            scale: pose.scale ? [...pose.scale] as [number, number, number] : undefined,
          }
          const next = [...t.keyframes, kf].sort((a, b) => a.time - b.time)
          return { ...t, keyframes: next }
        })
        return { ...c, tracks }
      })
      return { clips }
    }),

  removeKeyframe: (boneId, keyframeIndex) =>
    set((s) => {
      if (!s.activeClipId) return s
      const clips = s.clips.map((c) => {
        if (c.id !== s.activeClipId) return c
        const tracks = c.tracks.map((t) => {
          if (t.boneId !== boneId) return t
          const next = t.keyframes.filter((_, i) => i !== keyframeIndex)
          return { ...t, keyframes: next }
        })
        return { ...c, tracks }
      })
      return { clips, selectedKeyframe: null }
    }),

  updateKeyframeTime: (boneId, keyframeIndex, time) =>
    set((s) => {
      if (!s.activeClipId) return s
      const clippedTime = Math.max(0, Math.round(time * 1000) / 1000)
      const clips = s.clips.map((c) => {
        if (c.id !== s.activeClipId) return c
        const tracks = c.tracks.map((t) => {
          if (t.boneId !== boneId) return t
          const next = t.keyframes.map((k, i) => (i === keyframeIndex ? { ...k, time: clippedTime } : k))
          next.sort((a, b) => a.time - b.time)
          return { ...t, keyframes: next }
        })
        return { ...c, tracks }
      })
      return { clips }
    }),

  updateKeyframeValue: (boneId, keyframeIndex, field, value) =>
    set((s) => {
      if (!s.activeClipId) return s
      const clips = s.clips.map((c) => {
        if (c.id !== s.activeClipId) return c
        const tracks = c.tracks.map((t) => {
          if (t.boneId !== boneId) return t
          const next = t.keyframes.map((k, i) => {
            if (i !== keyframeIndex) return k
            const v: [number, number, number] = [value[0], value[1], value[2]]
            return { ...k, [field]: v }
          })
          return { ...t, keyframes: next }
        })
        return { ...c, tracks }
      })
      return { clips }
    }),

  moveKeyframeTime: (boneId, keyframeIndex, deltaTime) =>
    set((s) => {
      if (!s.activeClipId) return s
      const clips = s.clips.map((c) => {
        if (c.id !== s.activeClipId) return c
        const tracks = c.tracks.map((t) => {
          if (t.boneId !== boneId) return t
          const next = t.keyframes.map((k, i) => {
            if (i !== keyframeIndex) return k
            const newTime = Math.max(0, Math.round((k.time + deltaTime) * 1000) / 1000)
            return { ...k, time: newTime }
          })
          next.sort((a, b) => a.time - b.time)
          return { ...t, keyframes: next }
        })
        return { ...c, tracks }
      })
      return { clips }
    }),

  setPlaying: (playing) => set({ playing }),
  setLoop: (loop) => set({ loop }),
  setPlaybackSpeed: (speed) => set({ playbackSpeed: speed }),
  setCurrentTime: (time) => set({ currentTime: time }),

  selectBone: (boneId) =>
    set((s) => {
      const nextKeyframe =
        boneId && s.activeClipId
          ? null
          : null
      return { selectedBoneId: boneId, selectedKeyframe: nextKeyframe }
    }),

  selectKeyframe: (sel) => set({ selectedKeyframe: sel }),

  setClipDuration: (clipId, duration) =>
    set((s) => ({
      clips: s.clips.map((c) => (c.id === clipId ? { ...c, duration: Math.max(0.1, duration) } : c)),
    })),

  reset: () =>
    set({
      clips: [],
      activeClipId: null,
      playing: false,
      loop: true,
      playbackSpeed: 1,
      currentTime: 0,
      meshUrl: null,
      meshLabel: null,
      bones: [],
      selectedBoneId: null,
      selectedKeyframe: null,
      sceneRef: null,
    }),
}))
