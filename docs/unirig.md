# UniRig in Moss3D

Moss3D includes a built-in **UniRig** process extension for automatic skeleton prediction, skinning, and rigged GLB export. This document covers setup, workflows, the Generate tab 3D viewer, and Windows-specific notes.

## Requirements

- **NVIDIA GPU** with CUDA (used by PyTorch in the UniRig venv)
- **Python 3.11** for the UniRig virtual environment (Windows flash-attn wheel)
- **bpy** (Blender as Python) for mesh extract and merge/export steps
- Enough disk space for the UniRig clone, venv, and Hugging Face checkpoints

## Installation

From the repository root:

```bash
npm run setup-unirig
```

Or launch via `launcher.bat` / `launcher.sh`, which runs setup when the builtin extension is missing.

Setup will:

1. Clone [VAST-AI-Research/UniRig](https://github.com/VAST-AI-Research/UniRig) into `%APPDATA%\Moss3D\builtin-extensions\unirig\UniRig` (or the platform equivalent)
2. Create a dedicated venv and install PyTorch, PyG extensions, spconv, open3d, etc.
3. Install **flash-attn** on Windows via a prebuilt wheel (required for skin checkpoint weights)
4. Apply Moss3D patches (lazy imports, checkpoint loading, merge export, progress-friendly inference)

Re-run setup after pulling Moss3D updates if `DEPS_REVISION` in `setup.py` changes (marker file `.unirig-ready` in the extension directory).

## Workflow node

Add the **UniRig** extension node in the Workflows editor and connect a mesh input.

| Pipeline | Output | Description |
|----------|--------|-------------|
| **full** | Rigged `.glb` | Extract → skeleton → skin → merge into original mesh |
| **skeleton** | `.fbx` | Skeleton prediction only |
| **skin** | `.fbx` | Skin weights (expects a skeleton/rigged input) |

Pin nodes with the **eye icon** to expose parameters on the **Generate** tab. Connect the result to **Add to Scene** (or let the workflow runner load the output into the viewer).

### Parameters

- **Pipeline** — see table above
- **Seed** — random seed for skeleton/skin inference (default `12345`)

## Generate tab: skeleton in the 3D viewer

When a rigged model is loaded in the **Generate** viewer:

- The app detects armatures from **glTF skins**, `SkinnedMesh` skeletons, or `Bone` nodes
- Bones are drawn in **blue** with an x-ray style (`depthTest` off) so they remain visible **through the mesh**
- Use the **bone icon** in the left viewer toolbar to show or hide the skeleton
- **FBX** outputs (skeleton-only pipeline) are supported via `useFBX` in addition to GLB/GLTF

If no skeleton appears:

1. **Re-run UniRig** after updating Moss3D — older GLB files may have been exported without glTF skin data
2. Confirm the pipeline finished through **merge** (full pipeline) and produced a new `unirig-*.glb` under your workspace `Workflows` folder
3. Ensure **flash-attn** is installed in the UniRig venv (`npm run setup-unirig`)

## Moss3D patches (UniRig clone)

Applied under `builtin-extensions/unirig/UniRig` on setup:

| Patch | Purpose |
|-------|---------|
| `parse.py` | Lazy import of AR/skin models |
| `run.py` | PyTorch 2.6+ checkpoint load (`weights_only=False`, `Box` safe globals) |
| `ar.py` | Export `predict_skeleton.npz` in user/inference mode |
| `unirig_ar.py` / YAML | SDPA attention when flash-attn is unavailable (skeleton step) |
| `merge.py` | glTF export with `export_skins` / `export_def_bones`; clean exit on Windows after merge |
| Skin | Requires real **flash-attn** (no PyTorch MHA fallback — breaks checkpoint layout) |

## Windows notes

- **flash-attn**: Installed from the PLISGOOD wheel (`torch 2.11`, `cp311`). Required for the skin model; do not use the old MHA fallback patches.
- **Merge step**: Blender (`bpy`) may exit with code `0xC0000005` after a successful GLB write; Moss3D treats the step as success if the output file exists.
- **Progress**: Workflow progress is streamed over IPC during long UniRig runs.

## Key paths (default)

| Item | Location |
|------|----------|
| Extension root | `%APPDATA%\Moss3D\builtin-extensions\unirig\` |
| UniRig source | `...\unirig\UniRig\` |
| Python venv | `...\unirig\venv\` |
| HF checkpoints | `%USERPROFILE%\.cache\huggingface\hub\models--VAST-AI--UniRig\` |
| Workflow outputs | `<workspace>/Workflows/unirig-<timestamp>.glb` |

## Source files (Moss3D repo)

- `src/areas/workflows/nodes/unirig/manifest.json` — extension manifest
- `src/areas/workflows/nodes/unirig/processor.py` — pipeline orchestration
- `src/areas/workflows/nodes/unirig/setup.py` — install, deps, patches
- `src/areas/generate/components/Viewer3D.tsx` — 3D viewer
- `src/areas/generate/components/SkeletonOverlay.tsx` — skeleton visualization
