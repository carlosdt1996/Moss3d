import { useEffect, useMemo, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

const SKELETON_COLOR = 0x38bdf8
const RENDER_ORDER = 999

export type GltfParserLike = {
  json?: {
    nodes?: Array<{ name?: string; children?: number[] }>
    skins?: Array<{ joints?: number[] }>
  }
  nodes?: THREE.Object3D[]
}

function applyXRayMaterial(mat: THREE.Material): void {
  if ('color' in mat && mat.color instanceof THREE.Color) {
    mat.color.set(SKELETON_COLOR)
  }
  mat.depthTest = false
  mat.depthWrite = false
  mat.transparent = true
  mat.opacity = 1
}

export function sceneHasSkeleton(root: THREE.Object3D, parser?: GltfParserLike): boolean {
  if ((parser?.json?.skins?.length ?? 0) > 0) return true
  let found = false
  root.traverse((child) => {
    if (found) return
    if (child instanceof THREE.SkinnedMesh && (child.skeleton?.bones.length ?? 0) > 0) {
      found = true
    } else if (child instanceof THREE.Bone || child.type === 'Bone') {
      found = true
    }
  })
  return found
}

function findSkinnedMeshes(root: THREE.Object3D): THREE.SkinnedMesh[] {
  const meshes: THREE.SkinnedMesh[] = []
  root.traverse((child) => {
    if (child instanceof THREE.SkinnedMesh) meshes.push(child)
  })
  return meshes
}

function collectFromGltfParser(parser: GltfParserLike, root: THREE.Object3D): number[] {
  const skins = parser.json?.skins ?? []
  const jsonNodes = parser.json?.nodes ?? []
  const objNodes = parser.nodes ?? []
  if (!skins.length || !objNodes.length) return []

  const positions: number[] = []
  const invRoot = new THREE.Matrix4()
  const from = new THREE.Vector3()
  const to = new THREE.Vector3()
  const seen = new Set<string>()

  const addSegment = (a: THREE.Object3D, b: THREE.Object3D) => {
    const key = `${a.uuid}>${b.uuid}`
    if (seen.has(key)) return
    seen.add(key)
    a.getWorldPosition(from).applyMatrix4(invRoot)
    b.getWorldPosition(to).applyMatrix4(invRoot)
    positions.push(from.x, from.y, from.z, to.x, to.y, to.z)
  }

  root.updateMatrixWorld(true)
  invRoot.copy(root.matrixWorld).invert()

  for (const skin of skins) {
    for (const jointIdx of skin.joints ?? []) {
      const jointObj = objNodes[jointIdx]
      if (!jointObj?.parent) continue
      addSegment(jointObj.parent, jointObj)

      const nodeDef = jsonNodes[jointIdx]
      for (const childIdx of nodeDef?.children ?? []) {
        const childObj = objNodes[childIdx]
        if (childObj) addSegment(jointObj, childObj)
      }
    }
  }

  return positions
}

function collectBoneLinePositions(
  root: THREE.Object3D,
  skinnedMeshes: THREE.SkinnedMesh[],
  parser?: GltfParserLike,
): number[] {
  if (parser) {
    const fromParser = collectFromGltfParser(parser, root)
    if (fromParser.length > 0) return fromParser
  }

  const positions: number[] = []
  const invRoot = new THREE.Matrix4()
  const from = new THREE.Vector3()
  const to = new THREE.Vector3()
  const seen = new Set<string>()

  const addSegment = (aObj: THREE.Object3D, bObj: THREE.Object3D) => {
    const key = `${aObj.uuid}>${bObj.uuid}`
    if (seen.has(key)) return
    seen.add(key)
    aObj.getWorldPosition(from).applyMatrix4(invRoot)
    bObj.getWorldPosition(to).applyMatrix4(invRoot)
    positions.push(from.x, from.y, from.z, to.x, to.y, to.z)
  }

  root.updateMatrixWorld(true)
  invRoot.copy(root.matrixWorld).invert()

  for (const mesh of skinnedMeshes) {
    mesh.skeleton.update()
    for (const bone of mesh.skeleton.bones) {
      if (bone.parent) addSegment(bone.parent, bone)
    }
  }

  if (positions.length === 0) {
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Bone) && obj.type !== 'Bone') return
      for (const child of obj.children) {
        if (child instanceof THREE.Bone || child.type === 'Bone') addSegment(obj, child)
      }
    })
  }

  return positions
}

function collectJointPositions(
  root: THREE.Object3D,
  skinnedMeshes: THREE.SkinnedMesh[],
  parser?: GltfParserLike,
): THREE.Vector3[] {
  const joints: THREE.Vector3[] = []
  const invRoot = new THREE.Matrix4()
  const p = new THREE.Vector3()
  const seen = new Set<number>()

  root.updateMatrixWorld(true)
  invRoot.copy(root.matrixWorld).invert()

  const pushJoint = (obj: THREE.Object3D) => {
    obj.getWorldPosition(p).applyMatrix4(invRoot)
    const key = Math.round(p.x * 1e4) ^ Math.round(p.y * 1e4) ^ Math.round(p.z * 1e4)
    if (seen.has(key)) return
    seen.add(key)
    joints.push(p.clone())
  }

  if (parser?.json?.skins?.length && parser.nodes?.length) {
    for (const skin of parser.json.skins) {
      for (const jointIdx of skin.joints ?? []) {
        const jointObj = parser.nodes[jointIdx]
        if (jointObj) pushJoint(jointObj)
      }
    }
    if (joints.length > 0) return joints
  }

  for (const mesh of skinnedMeshes) {
    mesh.skeleton.update()
    for (const bone of mesh.skeleton.bones) pushJoint(bone)
  }

  if (joints.length === 0) {
    root.traverse((obj) => {
      if (obj instanceof THREE.Bone || obj.type === 'Bone') pushJoint(obj)
    })
  }

  return joints
}

function computeJointRadius(root: THREE.Object3D): number {
  const box = new THREE.Box3().setFromObject(root)
  const size = new THREE.Vector3()
  box.getSize(size)
  const maxDim = Math.max(size.x, size.y, size.z, 0.01)
  return maxDim * 0.015
}

interface SkeletonOverlayProps {
  root: THREE.Object3D
  gltfParser?: GltfParserLike
}

/**
 * Rig visualization nested under `<primitive object={root}>`.
 * Uses glTF skin joints when the file has skins; falls back to THREE.Bone / SkinnedMesh.
 */
export function SkeletonOverlay({ root, gltfParser }: SkeletonOverlayProps): JSX.Element {
  const skinnedMeshes = useMemo(() => findSkinnedMeshes(root), [root])

  const skeletonHelpers = useMemo(() => {
    return skinnedMeshes
      .filter((m) => (m.skeleton?.bones.length ?? 0) > 0)
      .map((mesh) => {
        const helper = new THREE.SkeletonHelper(mesh)
        applyXRayMaterial(helper.material as THREE.Material)
        helper.renderOrder = RENDER_ORDER
        helper.frustumCulled = false
        return helper
      })
  }, [skinnedMeshes])

  const lineMaterial = useMemo(() => {
    const mat = new THREE.LineBasicMaterial()
    applyXRayMaterial(mat)
    return mat
  }, [])

  const lineGeometry = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(0, 3))
    return geo
  }, [])

  const jointRadius = useMemo(() => computeJointRadius(root), [root])
  const [jointPositions, setJointPositions] = useState<THREE.Vector3[]>([])

  useEffect(() => {
    return () => {
      lineGeometry.dispose()
      lineMaterial.dispose()
      for (const helper of skeletonHelpers) {
        helper.geometry?.dispose()
        ;(helper.material as THREE.Material)?.dispose()
      }
    }
  }, [lineGeometry, lineMaterial, skeletonHelpers])

  useFrame(() => {
    const positions = collectBoneLinePositions(root, skinnedMeshes, gltfParser)

    const attr = lineGeometry.getAttribute('position') as THREE.BufferAttribute
    attr.array = new Float32Array(positions)
    attr.count = positions.length / 3
    attr.needsUpdate = true
    if (positions.length > 0) lineGeometry.computeBoundingSphere()

    setJointPositions(collectJointPositions(root, skinnedMeshes, gltfParser))

    for (const helper of skeletonHelpers) {
      applyXRayMaterial(helper.material as THREE.Material)
      helper.renderOrder = RENDER_ORDER
    }
    applyXRayMaterial(lineMaterial)
  })

  return (
    <group renderOrder={RENDER_ORDER}>
      {skeletonHelpers.map((helper, i) => (
        <primitive key={`skeleton-helper-${i}`} object={helper} />
      ))}
      <lineSegments
        geometry={lineGeometry}
        material={lineMaterial}
        renderOrder={RENDER_ORDER}
        frustumCulled={false}
        raycast={() => null}
      />
      {jointPositions.map((pos, i) => (
        <mesh
          key={`joint-${i}`}
          position={pos}
          renderOrder={RENDER_ORDER}
          frustumCulled={false}
          raycast={() => null}
        >
          <sphereGeometry args={[jointRadius, 10, 10]} />
          <meshBasicMaterial
            color={SKELETON_COLOR}
            depthTest={false}
            depthWrite={false}
            transparent
            opacity={1}
          />
        </mesh>
      ))}
    </group>
  )
}
