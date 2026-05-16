export interface RigBone {
  id: string
  name: string
  parentId: string | null
  /** Joint position in model-local space (centered like Viewer3D). */
  head: [number, number, number]
  /** Visual / export tail hint in model-local space. */
  tail: [number, number, number]
  /** Used when re-parenting after bone removal (body, hand, other). */
  group: string
}

export type RigBoneTreeNode = RigBone & { children: RigBoneTreeNode[] }
