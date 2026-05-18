import { Suspense, useCallback, useEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { GizmoHelper, OrbitControls, useGLTF, useGizmoContext } from '@react-three/drei'
import * as THREE from 'three'
import { useAppStore } from '@shared/stores/appStore'
import { useAnimateStore } from '../animateStore'
import { evaluateClipAtTime, extractClipsFromGltf } from '../animationEngine'
import { ModelErrorBoundary, ModelLoadError } from '@shared/components/ui'

const COLOR_BG = '#18181b'

function makeAxisLabelTexture(letter: string, bg: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.beginPath()
  ctx.arc(32, 32, 16, 0, 2 * Math.PI)
  ctx.closePath()
  ctx.fillStyle = bg
  ctx.fill()
  ctx.font = 'bold 18px Arial, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillStyle = '#ffffff'
  ctx.fillText(letter, 32, 41)
  return new THREE.CanvasTexture(canvas)
}

const GIZMO_AXES: {
  letter: string
  color: string
  pos: [number, number, number]
  lineRotation: [number, number, number]
}[] = [
  { letter: 'X', color: '#f87171', pos: [1, 0, 0], lineRotation: [0, 0, 0] },
  { letter: 'Y', color: '#4ade80', pos: [0, 1, 0], lineRotation: [0, 0, Math.PI / 2] },
  { letter: 'Z', color: '#60a5fa', pos: [0, 0, 1], lineRotation: [0, -Math.PI / 2, 0] },
]

function AxisBubble({ letter, color, pos }: {
  letter: string; color: string; pos: [number, number, number]
}) {
  const { tweenCamera } = useGizmoContext()
  const texture = useMemo(() => makeAxisLabelTexture(letter, color), [letter, color])
  return (
    <sprite
      position={pos}
      scale={1}
      onPointerDown={(e) => { tweenCamera(e.object.position); e.stopPropagation() }}
    >
      <spriteMaterial map={texture} alphaTest={0.3} toneMapped={false} />
    </sprite>
  )
}

function AxisLine({ color, rotation }: { color: string; rotation: [number, number, number] }) {
  return (
    <group rotation={rotation}>
      <mesh position={[0.4, 0, 0]}>
        <boxGeometry args={[0.8, 0.05, 0.05]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
    </group>
  )
}

function GizmoBubbles() {
  return (
    <group scale={40}>
      {GIZMO_AXES.map((axis) => (
        <AxisLine key={`line-${axis.letter}`} color={axis.color} rotation={axis.lineRotation} />
      ))}
      {GIZMO_AXES.map((axis) => (
        <AxisBubble key={axis.letter} {...axis} />
      ))}
    </group>
  )
}

function findBoneObject(scene: THREE.Object3D, name: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null
  scene.traverse((child) => {
    if (found) return
    if (child.name === name && (child instanceof THREE.Bone || child.type === 'Bone')) {
      found = child
    }
  })
  return found
}

function AnimatedModel({ url }: { url: string }) {
  const gltf = useGLTF(url)
  const scene = useMemo(() => gltf.scene.clone(true), [gltf.scene])

  const activeClipId = useAnimateStore((s) => s.activeClipId)
  const clips = useAnimateStore((s) => s.clips)
  const playing = useAnimateStore((s) => s.playing)
  const loop = useAnimateStore((s) => s.loop)
  const speed = useAnimateStore((s) => s.playbackSpeed)
  const setCurrentTime = useAnimateStore((s) => s.setCurrentTime)
  const currentTime = useAnimateStore((s) => s.currentTime)
  const bones = useAnimateStore((s) => s.bones)
  const selectedBoneId = useAnimateStore((s) => s.selectedBoneId)
  const setBones = useAnimateStore((s) => s.setBones)
  const addKeyframe = useAnimateStore((s) => s.addKeyframe)
  const setSceneRef = useAnimateStore((s) => s.setSceneRef)
  const storeClips = useAnimateStore((s) => s.clips)

  const clockRef = useRef(0)
  const hasInitialized = useRef(false)

  const activeClip = useMemo(() => clips.find((c) => c.id === activeClipId) ?? null, [clips, activeClipId])

  // Initialize bones from scene on first frame and extract GLTF animations
  useFrame((_, delta) => {
    if (!hasInitialized.current) {
      const foundNames: string[] = []
      scene.traverse((child) => {
        if ((child instanceof THREE.Bone || child.type === 'Bone') && child.name) {
          foundNames.push(child.name)
        }
      })
      if (bones.length === 0 && foundNames.length > 0) {
        scene.updateMatrixWorld(true)
        const newBones = foundNames.map((name, i) => ({
          id: `bone-${i}-${name}`,
          name,
          parentId: null as string | null,
          head: [0, 0, 0] as [number, number, number],
          tail: [0, 0.1, 0] as [number, number, number],
          group: 'other' as const,
        }))
        setBones(newBones)
      }

      // Extract animation clips from the GLTF if present
      if (gltf.animations && gltf.animations.length > 0) {
        const importedClips = extractClipsFromGltf(gltf)
        if (importedClips.length > 0 && storeClips.length === 0) {
          // Load clips into the store using setState directly
          const st = useAnimateStore.getState()
          // Replace empty clips with imported ones
          useAnimateStore.setState({
            clips: importedClips,
            activeClipId: importedClips[0]?.id ?? null,
          })
        }
      }

      hasInitialized.current = true
    }

    if (!playing || !activeClip) return

    clockRef.current += delta * speed
    const newTime = clockRef.current

    if (!loop && newTime >= activeClip.duration) {
      return
    }

    const wrappedTime = loop ? newTime % activeClip.duration : Math.min(newTime, activeClip.duration)
    evaluateClipAtTime(scene, activeClip, wrappedTime)
    setCurrentTime(wrappedTime)
  })

  // Sync clock on play/pause
  useEffect(() => {
    if (!playing) clockRef.current = currentTime
  }, [playing, currentTime])

  // Apply pose on scrub
  useEffect(() => {
    if (!playing && activeClip) {
      evaluateClipAtTime(scene, activeClip, currentTime)
    }
  }, [currentTime, playing, activeClip, scene])

  useEffect(() => {
    setSceneRef(scene)
    return () => { setSceneRef(null) }
  }, [scene, setSceneRef])

  // Keyframe hotkey
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'k' && e.key !== 'K') return
    if (document.activeElement instanceof HTMLInputElement) return
    if (!activeClip) return
    const selBone = bones.find((b) => b.id === selectedBoneId)
    if (!selBone) return
    const boneObj = findBoneObject(scene, selBone.name)
    if (!boneObj) return

    const radToDeg = 180 / Math.PI
    const cur = useAnimateStore.getState().currentTime
    addKeyframe(selBone.id, Math.round(cur * 100) / 100, {
      position: [boneObj.position.x, boneObj.position.y, boneObj.position.z],
      rotation: [
        boneObj.rotation.x * radToDeg,
        boneObj.rotation.y * radToDeg,
        boneObj.rotation.z * radToDeg,
      ],
      scale: [boneObj.scale.x, boneObj.scale.y, boneObj.scale.z],
    })
  }, [activeClip, bones, selectedBoneId, addKeyframe])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return <primitive object={scene} />
}

function EmptyState(): JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-700 pointer-events-none">
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.75">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
      <p className="mt-4 text-sm">Import or generate a 3D model to animate</p>
    </div>
  )
}

export default function AnimateViewer(): JSX.Element {
  const apiUrl = useAppStore((s) => s.apiUrl)
  const meshUrl = useAnimateStore((s) => s.meshUrl)

  const modelUrl = meshUrl
    ? (meshUrl.startsWith('http') ? meshUrl : `${apiUrl}${meshUrl}`)
    : null

  return (
    <ModelErrorBoundary resetKey={modelUrl} fallback={<ModelLoadError />}>
    <div className="relative w-full h-full bg-surface-400">
      {!modelUrl && <EmptyState />}

      <Canvas
        camera={{ position: [0, 1.5, 4], fov: 45 }}
        dpr={1}
        gl={{
          antialias: false,
          preserveDrawingBuffer: true,
          outputColorSpace: THREE.SRGBColorSpace,
          toneMapping: THREE.NeutralToneMapping,
          toneMappingExposure: 1.8,
        }}
      >
        <color attach="background" args={[COLOR_BG]} />

        <gridHelper args={[10, 20, '#3f3f46', '#27272a']} />

        <directionalLight position={[5, 8, 5]} intensity={1.5} color="#ffffff" />
        <directionalLight position={[-4, 2, -4]} intensity={0.6} color="#8888cc" />

        {modelUrl && (
          <Suspense fallback={null}>
            <AnimatedModel url={modelUrl} />
          </Suspense>
        )}

        <OrbitControls
          makeDefault
          enablePan
          enableZoom
          enableRotate
          minDistance={0.5}
          maxDistance={20}
          enableDamping
          dampingFactor={0.05}
        />

        <GizmoHelper alignment="top-right" margin={[72, 72]}>
          <GizmoBubbles />
        </GizmoHelper>
      </Canvas>

      {meshUrl && (
        <div className="absolute bottom-4 right-4 pointer-events-none">
          <p className="text-[10px] text-zinc-600">Press K to add keyframe</p>
        </div>
      )}
    </div>
    </ModelErrorBoundary>
  )
}
