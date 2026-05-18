import type { RigBone } from './rigTypes'

function normalizeBoneName(name: string): string {
  return name.replace(/^mixamorig:/i, '').trim()
}

function boneKey(name: string): string {
  return normalizeBoneName(name).replace(/\s+/g, '').toLowerCase()
}

function parseSpineIndex(name: string): number | null {
  const k = boneKey(name)
  if (k === 'spine') return 0
  const m = k.match(/^spine(\d+)$/)
  return m ? parseInt(m[1]!, 10) : null
}

function boneSortIndex(name: string): number {
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

export function compareBoneTreeOrder(a: RigBone, b: RigBone): number {
  const da = boneSortIndex(a.name)
  const db = boneSortIndex(b.name)
  if (da !== db) return da - db
  return normalizeBoneName(a.name).localeCompare(normalizeBoneName(b.name))
}
