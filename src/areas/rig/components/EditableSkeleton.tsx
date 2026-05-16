import { useLayoutEffect, useRef } from 'react'
import { TransformControls } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useRigStore } from '../rigStore'
import type { RigBone } from '../rigTypes'

const BONE_COLOR = 0x38bdf8
const SELECT_COLOR = 0xfbbf24

interface EditableSkeletonProps {
  jointRadius: number
}

function BoneJoint({
  bone,
  selected,
  radius,
  onSelect,
}: {
  bone: RigBone
  selected: boolean
  radius: number
  onSelect: () => void
}): JSX.Element {
  const pivotRef = useRef<THREE.Group>(null)
  const dragging = useRef(false)
  const moveBoneHead = useRigStore((s) => s.moveBoneHead)
  const { controls } = useThree()

  useLayoutEffect(() => {
    if (!pivotRef.current || dragging.current) return
    pivotRef.current.position.set(bone.head[0], bone.head[1], bone.head[2])
  }, [bone.head[0], bone.head[1], bone.head[2]])

  const commitPosition = () => {
    if (!pivotRef.current) return
    const p = pivotRef.current.position
    moveBoneHead(bone.id, [p.x, p.y, p.z])
  }

  return (
    <>
      <group ref={pivotRef}>
        <mesh
          renderOrder={1000}
          onClick={(e) => {
            e.stopPropagation()
            onSelect()
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <sphereGeometry args={[radius * (selected ? 1.35 : 1), 12, 12]} />
          <meshBasicMaterial
            color={selected ? SELECT_COLOR : BONE_COLOR}
            depthTest={false}
            depthWrite={false}
            transparent
            opacity={1}
          />
        </mesh>
      </group>
      {selected && (
        <TransformControls
          object={pivotRef}
          mode="translate"
          space="world"
          size={0.65}
          onMouseDown={() => {
            dragging.current = true
            if (controls && 'enabled' in controls) {
              (controls as { enabled: boolean }).enabled = false
            }
          }}
          onMouseUp={() => {
            dragging.current = false
            if (controls && 'enabled' in controls) {
              (controls as { enabled: boolean }).enabled = true
            }
            commitPosition()
          }}
          onObjectChange={() => {
            if (dragging.current) commitPosition()
          }}
        />
      )}
    </>
  )
}

function BoneSegments({ bones }: { bones: RigBone[] }): JSX.Element {
  const byId = new Map(bones.map((b) => [b.id, b]))
  const positions: number[] = []
  for (const bone of bones) {
    if (!bone.parentId) continue
    const parent = byId.get(bone.parentId)
    if (!parent) continue
    positions.push(...parent.head, ...bone.head)
  }

  return (
    <lineSegments renderOrder={999} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[new Float32Array(positions), 3]}
        />
      </bufferGeometry>
      <lineBasicMaterial
        color={BONE_COLOR}
        depthTest={false}
        depthWrite={false}
        transparent
      />
    </lineSegments>
  )
}

export function EditableSkeleton({ jointRadius }: EditableSkeletonProps): JSX.Element | null {
  const bones = useRigStore((s) => s.bones)
  const selectedBoneId = useRigStore((s) => s.selectedBoneId)
  const selectBone = useRigStore((s) => s.selectBone)

  if (!bones.length) return null

  return (
    <group renderOrder={998}>
      <BoneSegments bones={bones} />
      {bones.map((bone) => (
        <BoneJoint
          key={bone.id}
          bone={bone}
          selected={bone.id === selectedBoneId}
          radius={jointRadius}
          onSelect={() => selectBone(bone.id)}
        />
      ))}
    </group>
  )
}
