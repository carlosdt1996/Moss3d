import { Suspense, useEffect, useMemo, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { GizmoHelper, OrbitControls, useFBX, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh'
import type { GltfParserLike } from '@areas/generate/components/SkeletonOverlay'
import { useAppStore } from '@shared/stores/appStore'
import { useRigStore } from '../rigStore'
import { centerSceneOnGrid } from '../rigSkeleton'
import { EditableSkeleton } from './EditableSkeleton'
import { ModelErrorBoundary, ModelLoadError } from '@shared/components/ui'

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree as never
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree as never
THREE.Mesh.prototype.raycast = acceleratedRaycast

function modelFileExtension(url: string): string {
  const path = url.split('?')[0] ?? url
  return path.split('.').pop()?.toLowerCase() ?? ''
}

function RigModel({
  scene,
  url,
  gltfParser,
}: {
  scene: THREE.Object3D
  url: string
  gltfParser?: GltfParserLike
}): JSX.Element {
  const loadFromScene = useRigStore((s) => s.loadFromScene)
  const setSceneRef = useRigStore((s) => s.setSceneRef)
  const loaded = useRef(false)

  useEffect(() => {
    const ext = modelFileExtension(url)
    return () => {
      if (ext === 'fbx') useFBX.clear(url)
      else useGLTF.clear(url)
      setSceneRef(null)
      loaded.current = false
    }
  }, [url, scene, setSceneRef])

  useEffect(() => {
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        ;(child.geometry as THREE.BufferGeometry & { computeBoundsTree?: () => void }).computeBoundsTree?.()
        const mats = Array.isArray(child.material) ? child.material : [child.material]
        mats.forEach((m: THREE.Material) => { m.side = THREE.DoubleSide })
      }
    })
    centerSceneOnGrid(scene)
    setSceneRef(scene)
    if (!loaded.current) {
      loadFromScene(scene, gltfParser)
      loaded.current = true
    }
  }, [scene, gltfParser, loadFromScene, setSceneRef])

  const jointRadius = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene)
    const size = new THREE.Vector3()
    box.getSize(size)
    return Math.max(size.x, size.y, size.z, 0.01) * 0.018
  }, [scene])

  return (
    <primitive object={scene}>
      <EditableSkeleton jointRadius={jointRadius} />
    </primitive>
  )
}

function GltfRigModel({ url }: { url: string }): JSX.Element {
  const gltf = useGLTF(url) as { scene: THREE.Object3D; parser?: GltfParserLike }
  return <RigModel scene={gltf.scene} url={url} gltfParser={gltf.parser} />
}

function FbxRigModel({ url }: { url: string }): JSX.Element {
  const fbx = useFBX(url)
  return <RigModel scene={fbx} url={url} />
}

function LoadedRigModel({ url }: { url: string }): JSX.Element {
  if (modelFileExtension(url) === 'fbx') return <FbxRigModel url={url} />
  return <GltfRigModel url={url} />
}

function RigScene({ url }: { url: string }): JSX.Element {
  const selectBone = useRigStore((s) => s.selectBone)

  return (
    <>
      <color attach="background" args={['#0a0a0c']} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[4, 8, 6]} intensity={1.1} />
      <directionalLight position={[-5, 3, -4]} intensity={0.35} />
      <gridHelper args={[10, 20, '#2a2a35', '#1a1a22']} position={[0, 0, 0]} />
      <Suspense fallback={null}>
        <LoadedRigModel url={url} />
      </Suspense>
      <OrbitControls makeDefault />
      <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
        <mesh />
      </GizmoHelper>
      <mesh visible={false} onClick={() => selectBone(null)}>
        <planeGeometry args={[100, 100]} />
      </mesh>
    </>
  )
}

export default function RigViewer(): JSX.Element {
  const meshUrl = useRigStore((s) => s.meshUrl)
  const apiUrl = useAppStore((s) => s.apiUrl)

  const fullUrl = useMemo(() => {
    if (!meshUrl) return null
    if (meshUrl.startsWith('http')) return meshUrl
    return `${apiUrl}${meshUrl}`
  }, [meshUrl, apiUrl])

  if (!fullUrl) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">
        Importa un modelo o ?brelo desde Generate
      </div>
    )
  }

  return (
    <ModelErrorBoundary resetKey={fullUrl} fallback={<ModelLoadError />}>
    <div className="relative w-full h-full">
    <Canvas
      className="w-full h-full"
      camera={{ position: [2.2, 1.6, 2.8], fov: 45, near: 0.01, far: 1000 }}
      onCreated={({ gl }) => {
        gl.setClearColor('#0a0a0c')
      }}
    >
      <RigScene url={fullUrl} />
    </Canvas>
    </div>
    </ModelErrorBoundary>
  )
}
