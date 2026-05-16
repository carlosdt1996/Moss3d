import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import type { RigBone } from './rigTypes'
import { applyBonesToScene } from './rigSkeleton'

export async function exportRiggedGlb(
  scene: THREE.Object3D,
  bones: RigBone[],
): Promise<ArrayBuffer> {
  const clone = scene.clone(true)
  clone.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.material = Array.isArray(child.material)
        ? child.material.map((m) => m.clone())
        : (child.material as THREE.Material).clone()
    }
  })
  applyBonesToScene(clone, bones)

  const exporter = new GLTFExporter()
  return new Promise((resolve, reject) => {
    exporter.parse(
      clone,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(result)
          return
        }
        reject(new Error('GLTF export did not return binary data'))
      },
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
      { binary: true },
    )
  })
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}
