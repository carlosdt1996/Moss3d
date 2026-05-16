import * as THREE from 'three'
import type { GltfParserLike } from '@areas/generate/components/SkeletonOverlay'
import type { RigBone, RigBoneTreeNode } from './rigTypes'

const HAND_KEYS = ['hand', 'thumb', 'index', 'middle', 'ring', 'pinky', 'finger']
const BODY_KEYS = [
  'hips', 'spine', 'neck', 'head', 'shoulder', 'arm', 'forearm',
  'leg', 'foot', 'toe', 'upleg', 'thigh', 'calf', 'clavicle', 'chest',
]

export function inferBoneGroup(name: string): string {
  const lower = name.toLowerCase()
  if (HAND_KEYS.some((k) => lower.includes(k))) return 'hand'
  if (BODY_KEYS.some((k) => lower.includes(k))) return 'body'
  return 'other'
}

function vec3FromObject3D(obj: THREE.Object3D, invRoot: THREE.Matrix4): [number, number, number] {
  const p = new THREE.Vector3()
  obj.getWorldPosition(p).applyMatrix4(invRoot)
  return [p.x, p.y, p.z]
}

function defaultTail(head: [number, number, number], parentHead: [number, number, number] | null): [number, number, number] {
  if (parentHead) {
    const dx = head[0] - parentHead[0]
    const dy = head[1] - parentHead[1]
    const dz = head[2] - parentHead[2]
    const len = Math.hypot(dx, dy, dz) || 0.05
    const scale = 0.35 / len
    return [head[0] + dx * scale, head[1] + dy * scale, head[2] + dz * scale]
  }
  return [head[0], head[1] + 0.05, head[2]]
}

function findSkinnedMeshes(root: THREE.Object3D): THREE.SkinnedMesh[] {
  const meshes: THREE.SkinnedMesh[] = []
  root.traverse((child) => {
    if (child instanceof THREE.SkinnedMesh) meshes.push(child)
  })
  return meshes
}

function collectBoneObjects(root: THREE.Object3D): THREE.Bone[] {
  const skinned = findSkinnedMeshes(root)
  if (skinned.length > 0 && skinned[0].skeleton?.bones.length) {
    return [...skinned[0].skeleton.bones]
  }
  const bones: THREE.Bone[] = []
  root.traverse((obj) => {
    if (obj instanceof THREE.Bone || obj.type === 'Bone') bones.push(obj as THREE.Bone)
  })
  return bones
}

function parentBoneId(bone: THREE.Bone, idByUuid: Map<string, string>): string | null {
  let p: THREE.Object3D | null = bone.parent
  while (p) {
    if (p instanceof THREE.Bone || p.type === 'Bone') {
      const id = idByUuid.get(p.uuid)
      if (id) return id
    }
    p = p.parent
  }
  return null
}

export function centerSceneOnGrid(scene: THREE.Object3D): void {
  scene.position.set(0, 0, 0)
  const box = new THREE.Box3().setFromObject(scene)
  const center = new THREE.Vector3()
  box.getCenter(center)
  scene.position.set(-center.x, -box.min.y, -center.z)
}

export function extractBonesFromScene(scene: THREE.Object3D, _parser?: GltfParserLike): RigBone[] {
  scene.updateMatrixWorld(true)
  const invRoot = scene.matrixWorld.clone().invert()
  const boneObjs = collectBoneObjects(scene)
  if (!boneObjs.length) return []

  const idByUuid = new Map<string, string>()
  for (const b of boneObjs) idByUuid.set(b.uuid, b.uuid)

  const bones: RigBone[] = []
  for (const bone of boneObjs) {
    const head = vec3FromObject3D(bone, invRoot)
    const parentId = parentBoneId(bone, idByUuid)
    const parentHead = parentId
      ? bones.find((x) => x.id === parentId)?.head ?? null
      : null
    let tail = defaultTail(head, parentHead)
    for (const child of bone.children) {
      if (child instanceof THREE.Bone || child.type === 'Bone') {
        tail = vec3FromObject3D(child, invRoot)
        break
      }
    }
    bones.push({
      id: bone.uuid,
      name: bone.name || `bone_${bones.length}`,
      parentId,
      head,
      tail,
      group: inferBoneGroup(bone.name),
    })
  }
  return bones
}

export function createDefaultHumanoidRig(scene: THREE.Object3D): RigBone[] {
  const box = new THREE.Box3().setFromObject(scene)
  const size = new THREE.Vector3()
  box.getSize(size)
  const h = Math.max(size.y, 0.5)
  const hips: [number, number, number] = [0, h * 0.52, 0]
  const spine: [number, number, number] = [0, h * 0.65, 0]
  const chest: [number, number, number] = [0, h * 0.78, 0]
  const neck: [number, number, number] = [0, h * 0.88, 0]
  const head: [number, number, number] = [0, h * 0.95, 0]

  const rootId = crypto.randomUUID()
  const s1 = crypto.randomUUID()
  const s2 = crypto.randomUUID()
  const nId = crypto.randomUUID()
  const hId = crypto.randomUUID()

  return [
    { id: rootId, name: 'Hips', parentId: null, head: hips, tail: spine, group: 'body' },
    { id: s1, name: 'Spine', parentId: rootId, head: spine, tail: chest, group: 'body' },
    { id: s2, name: 'Spine1', parentId: s1, head: chest, tail: neck, group: 'body' },
    { id: nId, name: 'Neck', parentId: s2, head: neck, tail: head, group: 'body' },
    { id: hId, name: 'Head', parentId: nId, head, tail: [head[0], head[1] + h * 0.08, head[2]], group: 'body' },
  ]
}

export function buildBoneTree(bones: RigBone[]): RigBoneTreeNode[] {
  const map = new Map<string, RigBoneTreeNode>()
  for (const b of bones) map.set(b.id, { ...b, children: [] })
  const roots: RigBoneTreeNode[] = []
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  const sortNodes = (nodes: RigBoneTreeNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name))
    for (const n of nodes) sortNodes(n.children)
  }
  sortNodes(roots)
  return roots
}

function dist3(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function closestBone(head: [number, number, number], candidates: RigBone[]): RigBone | null {
  if (!candidates.length) return null
  let best = candidates[0]
  let d = dist3(head, best.head)
  for (const c of candidates.slice(1)) {
    const nd = dist3(head, c.head)
    if (nd < d) {
      d = nd
      best = c
    }
  }
  return best
}

export function findReparentTarget(
  bones: RigBone[],
  child: RigBone,
  removed: RigBone,
): string | null {
  const pool = bones.filter((b) => b.id !== child.id && b.id !== removed.id)
  if (!pool.length) return null

  const sameGroup = pool.filter((b) => b.group === child.group)
  if (sameGroup.length) return closestBone(child.head, sameGroup)!.id

  let pid: string | null = removed.parentId
  while (pid) {
    const parent = bones.find((b) => b.id === pid)
    if (parent) {
      const sibs = pool.filter(
        (b) => b.parentId === parent.id || b.id === parent.id,
      )
      if (sibs.length) return closestBone(child.head, sibs)!.id
    }
    pid = parent?.parentId ?? null
  }

  return closestBone(child.head, pool)?.id ?? null
}

export function removeBoneWithRebalance(bones: RigBone[], boneId: string): RigBone[] {
  const removed = bones.find((b) => b.id === boneId)
  if (!removed) return bones

  const childIds = bones.filter((b) => b.parentId === boneId).map((b) => b.id)
  let next = bones.filter((b) => b.id !== boneId)

  for (const childId of childIds) {
    const child = bones.find((b) => b.id === childId)!
    const newParentId = findReparentTarget(next, child, removed)
    next = next.map((b) =>
      b.id === childId ? { ...b, parentId: newParentId } : b,
    )
  }
  return next
}

export function addChildBone(
  bones: RigBone[],
  parentId: string | null,
  name?: string,
): RigBone[] {
  const parent = parentId ? bones.find((b) => b.id === parentId) : null
  const head: [number, number, number] = parent
    ? [...parent.tail]
    : [0, 0.5, 0]
  const tail = defaultTail(head, parent?.head ?? null)
  const id = crypto.randomUUID()
  const boneName = name ?? `bone_${bones.length}`
  return [
    ...bones,
    {
      id,
      name: boneName,
      parentId,
      head,
      tail,
      group: inferBoneGroup(boneName),
    },
  ]
}

export function applyBonesToScene(scene: THREE.Object3D, bones: RigBone[]): void {
  const boneObjs = collectBoneObjects(scene)
  if (!boneObjs.length) return

  scene.updateMatrixWorld(true)
  const invRoot = scene.matrixWorld.clone().invert()
  const byId = new Map(bones.map((b) => [b.id, b]))

  for (const bone of boneObjs) {
    const data = byId.get(bone.uuid)
    if (!data) continue

    const worldHead = new THREE.Vector3(...data.head).applyMatrix4(scene.matrixWorld)
    if (bone.parent) {
      bone.parent.updateMatrixWorld(true)
      const local = bone.parent.worldToLocal(worldHead.clone())
      bone.position.copy(local)
    } else {
      bone.position.copy(worldHead)
    }
    bone.updateMatrixWorld(true)
  }

  for (const mesh of findSkinnedMeshes(scene)) {
    mesh.skeleton?.update()
    mesh.skeleton?.calculateInverses()
  }

  void invRoot
}
