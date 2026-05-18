import * as THREE from 'three'
import type { AnimationClip, AnimationTrack, Keyframe } from './animateTypes'

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function lerpArray(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
}

function findBoneInScene(scene: THREE.Object3D, boneName: string): THREE.Object3D | null {
  if (!scene) return null
  let found: THREE.Object3D | null = null
  scene.traverse((child) => {
    if (found) return
    if (child.name === boneName || (child.type === 'Bone' && child.name === boneName)) {
      found = child
    }
  })
  return found
}

export function getBoneNamesFromScene(scene: THREE.Object3D): string[] {
  const allBones: string[] = []
  scene.traverse((child) => {
    if ((child instanceof THREE.Bone || child.type === 'Bone') && child.name) {
      allBones.push(child.name)
    }
  })
  scene.traverse((child) => {
    if (child instanceof THREE.SkinnedMesh && child.skeleton) {
      for (const bone of child.skeleton.bones) {
        if (bone.name && !allBones.includes(bone.name)) {
          allBones.push(bone.name)
        }
      }
    }
  })
  return allBones
}

function evaluateTrackAtTime(track: AnimationTrack, time: number): Keyframe | null {
  const kfs = track.keyframes
  if (kfs.length === 0) return null
  if (kfs.length === 1) return kfs[0]

  const last = kfs[kfs.length - 1]
  if (time <= kfs[0].time) return kfs[0]
  if (time >= last.time) return last

  let after = 0
  for (let i = 0; i < kfs.length; i++) {
    if (kfs[i].time > time) {
      after = i
      break
    }
  }
  const before = after - 1
  const kfA = kfs[before]
  const kfB = kfs[after]
  const range = kfB.time - kfA.time
  const t = range > 0 ? (time - kfA.time) / range : 0

  const result: Keyframe = { time }
  if (kfA.position && kfB.position) {
    result.position = lerpArray(kfA.position, kfB.position, t)
  }
  if (kfA.rotation && kfB.rotation) {
    result.rotation = lerpArray(kfA.rotation, kfB.rotation, t)
  }
  if (kfA.scale && kfB.scale) {
    result.scale = lerpArray(kfA.scale, kfB.scale, t)
  }
  return result
}

export function evaluateClipAtTime(
  scene: THREE.Object3D,
  clip: AnimationClip,
  time: number,
): void {
  if (!scene) return

  const wrappedTime = clip.loop && clip.duration > 0
    ? time % clip.duration
    : Math.min(time, clip.duration || 0)

  scene.updateMatrixWorld(true)

  for (const track of clip.tracks) {
    const bone = findBoneInScene(scene, track.boneName)
    if (!bone) continue

    const pose = evaluateTrackAtTime(track, wrappedTime)
    if (!pose) continue

    if (pose.position) {
      bone.position.set(pose.position[0], pose.position[1], pose.position[2])
    }
    if (pose.rotation) {
      const degToRad = Math.PI / 180
      bone.rotation.set(
        pose.rotation[0] * degToRad,
        pose.rotation[1] * degToRad,
        pose.rotation[2] * degToRad,
      )
    }
    if (pose.scale) {
      bone.scale.set(pose.scale[0], pose.scale[1], pose.scale[2])
    }
  }

  scene.updateMatrixWorld(true)

  scene.traverse((child) => {
    if (child instanceof THREE.SkinnedMesh && child.skeleton) {
      child.skeleton.update()
    }
  })
}

export function buildThreeKeyframeTracks(
  clip: AnimationClip,
): THREE.KeyframeTrack[] {
  const tracks: THREE.KeyframeTrack[] = []

  for (const track of clip.tracks) {
    if (track.keyframes.length === 0) continue

    const times: number[] = []
    const posValues: number[] = []
    const rotValues: number[] = []
    const sclValues: number[] = []

    const hasPos = track.keyframes.some((k) => k.position)
    const hasRot = track.keyframes.some((k) => k.rotation)
    const hasScl = track.keyframes.some((k) => k.scale)
    const targetName = track.boneName
    const bonePath = `.bones["${targetName}"]`

    for (const kf of track.keyframes) {
      times.push(kf.time)
      if (hasPos) {
        posValues.push(...(kf.position ?? [0, 0, 0]))
      }
      if (hasRot) {
        const degToRad = Math.PI / 180
        const r = kf.rotation ?? [0, 0, 0]
        rotValues.push(r[0] * degToRad, r[1] * degToRad, r[2] * degToRad)
      }
      if (hasScl) {
        sclValues.push(...(kf.scale ?? [1, 1, 1]))
      }
    }

    if (hasPos && times.length >= 1) {
      const kt = new THREE.VectorKeyframeTrack(
        `${bonePath}.position`,
        times,
        posValues,
      )
      tracks.push(kt)
    }
    if (hasRot && times.length >= 2) {
      const kt = new THREE.VectorKeyframeTrack(
        `${bonePath}.rotation`,
        times,
        rotValues,
      )
      tracks.push(kt)
    }
    if (hasScl && times.length >= 1) {
      const kt = new THREE.VectorKeyframeTrack(
        `${bonePath}.scale`,
        times,
        sclValues,
      )
      tracks.push(kt)
    }
  }

  return tracks
}

export function getBoneRestPose(
  scene: THREE.Object3D,
  boneName: string,
): { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] } | null {
  const bone = findBoneInScene(scene, boneName)
  if (!bone) return null

  const pos: [number, number, number] = [bone.position.x, bone.position.y, bone.position.z]
  const radToDeg = 180 / Math.PI
  const rot: [number, number, number] = [
    bone.rotation.x * radToDeg,
    bone.rotation.y * radToDeg,
    bone.rotation.z * radToDeg,
  ]
  const scl: [number, number, number] = [bone.scale.x, bone.scale.y, bone.scale.z]

  return { position: pos, rotation: rot, scale: scl }
}

export function resetBonePose(scene: THREE.Object3D, boneName: string): void {
  const bone = findBoneInScene(scene, boneName)
  if (!bone) return
  bone.position.set(0, 0, 0)
  bone.rotation.set(0, 0, 0)
  bone.scale.set(1, 1, 1)
}

export function resetAllBonePoses(scene: THREE.Object3D, boneNames: string[]): void {
  for (const name of boneNames) {
    resetBonePose(scene, name)
  }
}

export function extractClipsFromGltf(
  gltf: { animations?: THREE.AnimationClip[] },
): AnimationClip[] {
  const threeClips = gltf.animations ?? []
  if (threeClips.length === 0) return []

  return threeClips.map((threeClip) => {
    const tracks: AnimationTrack[] = []
    const radToDeg = 180 / Math.PI

    for (const kt of threeClip.tracks) {
      const props = kt.name.split('.')
      const boneName = props.length > 2 && props[0] === 'bones'
        ? props[1].replace(/^\[?"?|"\]?$/g, '')
        : props[props.length - 2] ?? kt.name

      if (!tracks.find((t) => t.boneName === boneName)) {
        tracks.push({
          boneId: boneName,
          boneName,
          keyframes: [],
        })
      }

      const track = tracks.find((t) => t.boneName === boneName)!
      const isRotation = kt.name.endsWith('.rotation') || kt.name.endsWith('.quaternion')
      const isPosition = kt.name.endsWith('.position')
      const isScale = kt.name.endsWith('.scale')

      for (let i = 0; i < kt.times.length; i++) {
        const time = kt.times[i]
        let kf = track.keyframes.find((k) => Math.abs(k.time - time) < 0.001)
        if (!kf) {
          kf = { time: Math.round(time * 1000) / 1000 }
          track.keyframes.push(kf)
        }

        const stride = kt.values.length / kt.times.length
        const base = i * stride

        if (isRotation && stride === 3) {
          kf.rotation = [
            Math.round(kt.values[base] * radToDeg * 100) / 100,
            Math.round(kt.values[base + 1] * radToDeg * 100) / 100,
            Math.round(kt.values[base + 2] * radToDeg * 100) / 100,
          ]
        } else if (isRotation && stride === 4) {
          const q = new THREE.Quaternion(
            kt.values[base],
            kt.values[base + 1],
            kt.values[base + 2],
            kt.values[base + 3],
          )
          const euler = new THREE.Euler().setFromQuaternion(q, 'XYZ')
          kf.rotation = [
            Math.round(euler.x * radToDeg * 100) / 100,
            Math.round(euler.y * radToDeg * 100) / 100,
            Math.round(euler.z * radToDeg * 100) / 100,
          ]
        }

        if (isPosition && stride === 3) {
          kf.position = [
            Math.round(kt.values[base] * 100) / 100,
            Math.round(kt.values[base + 1] * 100) / 100,
            Math.round(kt.values[base + 2] * 100) / 100,
          ]
        }

        if (isScale && stride === 3) {
          kf.scale = [
            Math.round(kt.values[base] * 100) / 100,
            Math.round(kt.values[base + 1] * 100) / 100,
            Math.round(kt.values[base + 2] * 100) / 100,
          ]
        }
      }
    }

    for (const track of tracks) {
      track.keyframes.sort((a, b) => a.time - b.time)
    }

    return {
      id: `imported-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: threeClip.name || 'Imported Clip',
      duration: threeClip.duration,
      loop: true,
      tracks: tracks.filter((t) => t.keyframes.length > 0),
    }
  })
}
