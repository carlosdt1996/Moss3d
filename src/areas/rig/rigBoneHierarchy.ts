import type { RigBone } from './rigTypes'

/** Strip rig prefixes for matching. */
export function normalizeBoneName(name: string): string {
  return name.replace(/^mixamorig:/i, '').trim()
}

/** Collapse spaces for key lookup: "Spine 1" → "spine1", "Right Arm" → "rightarm". */
export function boneKey(name: string): string {
  return normalizeBoneName(name).replace(/\s+/g, '').toLowerCase()
}

function findBoneByKey(bones: RigBone[], key: string): RigBone | undefined {
  const k = boneKey(key)
  return bones.find((b) => boneKey(b.name) === k)
}

function findBoneByKeys(bones: RigBone[], keys: string[]): RigBone | undefined {
  for (const key of keys) {
    const hit = findBoneByKey(bones, key)
    if (hit) return hit
  }
  return undefined
}

function parseSpineIndex(name: string): number | null {
  const k = boneKey(name)
  if (k === 'spine') return 0
  const m = k.match(/^spine(\d+)$/)
  return m ? parseInt(m[1]!, 10) : null
}

function topSpineBone(bones: RigBone[]): RigBone | undefined {
  let best: RigBone | undefined
  let bestN = -1
  for (const b of bones) {
    const n = parseSpineIndex(b.name)
    if (n === null) continue
    if (n > bestN) {
      bestN = n
      best = b
    }
  }
  return best ?? findBoneByKey(bones, 'spine')
}

function isMixamoStyleName(name: string): boolean {
  const k = boneKey(name)
  if (k === 'root' || /^bone_\d+$/.test(k)) return false
  return (
    /^hips\d*$/.test(k) ||
    /^spine\d*$/.test(k) ||
    /^(neck|head)$/.test(k) ||
    /^(left|right)(shoulder|arm|forearm|hand|upleg|leg|foot|toebase)$/.test(k) ||
    /^(left|right)hand(thumb|index|middle|ring|pinky)\d+$/.test(k)
  )
}

function mixamoRatio(bones: RigBone[]): number {
  if (!bones.length) return 0
  return bones.filter((b) => isMixamoStyleName(b.name)).length / bones.length
}

/** Display / tree order (lower = earlier). */
export function boneSortIndex(name: string): number {
  const k = boneKey(name)

  if (k === 'hips') return 0
  if (k === 'hips1') return 1

  const spineN = parseSpineIndex(name)
  if (spineN !== null) return 20 + spineN

  if (k === 'neck') return 30
  if (k === 'head') return 31

  const sideOffset = k.startsWith('left') ? 0 : k.startsWith('right') ? 50 : 0

  if (k.endsWith('shoulder')) return 40 + sideOffset
  if (k.endsWith('forearm')) return 120 + sideOffset
  if (/^(left|right)arm$/.test(k)) return 110 + sideOffset
  if (/^(left|right)hand$/.test(k)) return 130 + sideOffset

  const finger = k.match(/^(left|right)hand(thumb|index|middle|ring|pinky)(\d+)$/)
  if (finger) {
    const digit = finger[2]!
    const num = parseInt(finger[3]!, 10)
    const digitBase =
      { thumb: 0, index: 10, middle: 20, ring: 30, pinky: 40 }[digit] ?? 50
    return 200 + sideOffset + digitBase + num
  }

  if (k.endsWith('upleg')) return 60 + sideOffset
  if (k.endsWith('leg') && !k.includes('up')) return 310 + sideOffset
  if (k.endsWith('foot')) return 320 + sideOffset
  if (k.includes('toe')) return 330 + sideOffset

  if (k.startsWith('bone_')) return 9000 + parseInt(k.slice(5), 10) || 0
  return 5000 + k.charCodeAt(0)
}

function inferParentIdFromName(bone: RigBone, bones: RigBone[]): string | null {
  const k = boneKey(bone.name)

  if (k === 'root') return null

  // Hips > Hips 1 (hips chain only — not parent of spine/legs/shoulders)
  if (k === 'hips1') return findBoneByKeys(bones, ['hips'])?.id ?? null
  if (k === 'hips') return null

  // Spine > Spine 1 > … (spine chain only — root-level sibling of hips/legs/shoulders)
  const spineN = parseSpineIndex(bone.name)
  if (spineN !== null) {
    if (spineN === 0) return null
    return (
      findBoneByKeys(bones, [`spine ${spineN - 1}`, `spine${spineN - 1}`, 'spine'])?.id ?? null
    )
  }

  if (k === 'neck' || k === 'head') {
    if (k === 'head') return findBoneByKeys(bones, ['neck'])?.id ?? null
    return topSpineBone(bones)?.id ?? null
  }

  const sideMatch = k.match(/^(left|right)(.+)$/)
  if (!sideMatch) return null
  const side = sideMatch[1]!
  const part = sideMatch[2]!

  const finger = part.match(/^hand(thumb|index|middle|ring|pinky)(\d+)$/)
  if (finger) {
    const digit = finger[1]!
    const num = parseInt(finger[2]!, 10)
    const handKey = `${side}hand`
    if (num <= 1) return findBoneByKey(bones, handKey)?.id ?? null
    return findBoneByKey(bones, `${side}hand${digit}${num - 1}`)?.id ?? null
  }

  // RightShoulder > Right Arm > Right Hand (shoulder root-level, same as spine/hips/legs)
  if (part === 'shoulder') return null
  if (part === 'arm') return findBoneByKey(bones, `${side}shoulder`)?.id ?? null
  if (part === 'forearm') return findBoneByKey(bones, `${side}arm`)?.id ?? null
  if (part === 'hand') {
    return (
      findBoneByKey(bones, `${side}forearm`)?.id ??
      findBoneByKey(bones, `${side}arm`)?.id ??
      null
    )
  }

  if (part === 'upleg') return null
  if (part === 'leg') return findBoneByKey(bones, `${side}upleg`)?.id ?? null
  if (part === 'foot') return findBoneByKey(bones, `${side}leg`)?.id ?? null
  if (part.includes('toe')) return findBoneByKey(bones, `${side}foot`)?.id ?? null

  return null
}

function dist3(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function inferParentSpatial(
  bone: RigBone,
  bones: RigBone[],
  parentIds: Map<string, string | null>,
): string | null {
  const others = bones.filter((b) => b.id !== bone.id)
  if (!others.length) return null

  const bodyPool = others.filter(
    (b) => b.group === 'body' || !/^bone_\d+$/i.test(boneKey(b.name)),
  )
  const pool = bodyPool.length ? bodyPool : others

  let best: RigBone | null = null
  let bestScore = Infinity
  for (const c of pool) {
    const dy = bone.head[1] - c.head[1]
    if (dy < -0.02) continue
    const d = dist3(bone.head, c.head)
    const score = d + (dy > 0.15 ? dy * 2 : 0)
    if (score < bestScore) {
      bestScore = score
      best = c
    }
  }
  if (!best) return findBoneByKey(bones, 'hips')?.id ?? pool[0]?.id ?? null
  if (parentIds.get(best.id) === bone.id) return findBoneByKey(bones, 'hips')?.id ?? null
  return best.id
}

function breakCycles(parentIds: Map<string, string | null>, bones: RigBone[]): void {
  const byId = new Map(bones.map((b) => [b.id, b]))
  for (const bone of bones) {
    const seen = new Set<string>()
    let cur: string | null = bone.id
    while (cur) {
      if (seen.has(cur)) {
        parentIds.set(bone.id, findBoneByKey(bones, 'hips')?.id ?? null)
        break
      }
      seen.add(cur)
      const p = parentIds.get(cur) ?? null
      cur = p
      if (p && !byId.has(p)) {
        parentIds.set(bone.id, null)
        break
      }
    }
  }
}

function retargetTails(bones: RigBone[]): RigBone[] {
  const byId = new Map(bones.map((b) => [b.id, b]))
  const children = new Map<string, RigBone[]>()
  for (const b of bones) {
    if (!b.parentId) continue
    const list = children.get(b.parentId) ?? []
    list.push(b)
    children.set(b.parentId, list)
  }

  return bones.map((b) => {
    const kids = children.get(b.id)
    if (kids?.length) {
      const primary = [...kids].sort(
        (a, c) => boneSortIndex(a.name) - boneSortIndex(c.name),
      )[0]!
      return { ...b, tail: [...primary.head] as [number, number, number] }
    }
    const parent = b.parentId ? byId.get(b.parentId) : null
    if (parent) {
      const dx = b.head[0] - parent.head[0]
      const dy = b.head[1] - parent.head[1]
      const dz = b.head[2] - parent.head[2]
      const len = Math.hypot(dx, dy, dz) || 0.05
      const s = 0.35 / len
      return {
        ...b,
        tail: [b.head[0] + dx * s, b.head[1] + dy * s, b.head[2] + dz * s],
      }
    }
    return b
  })
}

/**
 * Rebuild parent links from humanoid bone names when the file skeleton graph is wrong.
 *
 * Root-level siblings (same tier): Hips, Spine, legs (UpLeg), shoulders.
 *   Hips > Hips 1
 *   Spine > Spine 1 > … > Neck > Head
 *   RightShoulder > Right Arm > Right Hand > fingers
 *   LeftUpLeg > Left Leg > …
 */
export function normalizeBoneHierarchy(bones: RigBone[]): RigBone[] {
  if (bones.length < 2) return bones

  const useNames = mixamoRatio(bones) >= 0.35
  const parentIds = new Map<string, string | null>()

  for (const bone of bones) {
    let parentId: string | null = null
    if (useNames) parentId = inferParentIdFromName(bone, bones)
    if (parentId === null && !useNames) parentId = bone.parentId
    parentIds.set(bone.id, parentId)
  }

  if (useNames) {
    for (const bone of bones) {
      if (parentIds.get(bone.id) != null) continue
      const fromName = inferParentIdFromName(bone, bones)
      if (fromName) parentIds.set(bone.id, fromName)
    }
    for (const bone of bones) {
      if (/^bone_\d+$/i.test(boneKey(bone.name))) {
        parentIds.set(bone.id, inferParentSpatial(bone, bones, parentIds))
      }
    }
  } else {
    for (const bone of bones) {
      if (parentIds.get(bone.id) == null && bone.parentId) {
        parentIds.set(bone.id, bone.parentId)
      }
    }
  }

  const hips = findBoneByKey(bones, 'hips')
  if (hips) parentIds.set(hips.id, null)

  breakCycles(parentIds, bones)

  return retargetTails(
    bones.map((b) => ({
      ...b,
      parentId: parentIds.get(b.id) ?? null,
    })),
  )
}

export function compareBoneTreeOrder(a: RigBone, b: RigBone): number {
  const da = boneSortIndex(a.name)
  const db = boneSortIndex(b.name)
  if (da !== db) return da - db
  return normalizeBoneName(a.name).localeCompare(normalizeBoneName(b.name))
}
