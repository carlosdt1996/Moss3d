"""
Animate — built-in process extension (rigged GLB → animated GLB).

Uses HY-Motion 1.0 to generate skeleton animations from text prompts.
Outputs a GLB with embedded animation clips that can be refined in the Animate tab.

Protocol (stdin/stdout newline-delimited JSON):

stdin:  { "input": { "filePath": "...", "text": "prompt" }, "params": {...}, "workspaceDir": "...", "tempDir": "..." }
stdout: { "type": "progress"|"log"|"done"|"error", ... }
"""
from __future__ import annotations

import json
import os
import shutil
import struct
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def progress(pct: int, label: str) -> None:
    emit({"type": "progress", "percent": pct, "label": label})


def log(msg: str) -> None:
    emit({"type": "log", "message": msg})


def done(file_path: str) -> None:
    emit({"type": "done", "result": {"filePath": file_path}})


def error(msg: str) -> None:
    emit({"type": "error", "message": msg})


EXT_DIR = Path(__file__).resolve().parent
HYMOTION_ROOT = EXT_DIR / "HY-Motion"
READY_MARKER = EXT_DIR / ".animate-ready"
RETARGETING_MODULE = EXT_DIR / "retargeting.py"


def python_exe() -> str:
    venv_py = (
        EXT_DIR / "venv" / "Scripts" / "python.exe"
        if os.name == "nt"
        else EXT_DIR / "venv" / "bin" / "python3"
    )
    if venv_py.is_file():
        return str(venv_py)
    return sys.executable


def read_glb_skeleton_metadata(glb_path: Path) -> dict:
    """Extract skeleton bone names from a GLB file by parsing its JSON header."""
    with open(glb_path, "rb") as f:
        header = f.read(12)
        if header[:4] != b"\x67\x6c\x54\x46":
            raise ValueError("Not a valid glTF/GLB file")

        total_length = struct.unpack("<I", header[8:12])[0]
        f.seek(0)
        chunk_data = f.read(total_length)

    offset = 12
    json_chunk_length = struct.unpack_from("<I", chunk_data, offset)[0]
    offset += 4
    json_chunk_type = chunk_data[offset : offset + 4]
    offset += 4
    if json_chunk_type != b"JSON":
        raise ValueError("Expected JSON chunk in GLB")

    json_data = chunk_data[offset : offset + json_chunk_length]
    gltf = json.loads(json_data)

    nodes = gltf.get("nodes", [])
    skins = gltf.get("skins", [])

    bone_names: list[str] = []
    skinned_mesh_indices: set[int] = set()
    joint_indices: set[int] = set()

    for skin in skins:
        for j in skin.get("joints", []):
            joint_indices.add(j)

    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            for attr_name in prim.get("attributes", {}):
                if attr_name.startswith("JOINTS_"):
                    if "node" in mesh:
                        skinned_mesh_indices.add(mesh["node"])

    all_bone_indices = joint_indices | skinned_mesh_indices

    def collect_bones(node_idx: int, nodes_list: list) -> None:
        if node_idx < 0 or node_idx >= len(nodes_list):
            return
        node = nodes_list[node_idx]
        name = node.get("name", "")
        if name:
            bone_names.append(name)
        for child_idx in node.get("children", []):
            collect_bones(child_idx, nodes_list)

    for bone_idx in all_bone_indices:
        if bone_idx < len(nodes):
            name = nodes[bone_idx].get("name", "")
            if name and name not in bone_names:
                bone_names.append(name)

    return {
        "bone_names": bone_names,
        "joint_count": len(joint_indices),
        "has_skeleton": len(joint_indices) > 0 or len(skins) > 0,
    }


def run_hymotion_inference(
    prompt: str,
    duration: float,
    model_size: str,
    seed: int,
    prompt_engineering: bool,
    temp_dir: Path,
) -> Path:
    """Run HY-Motion inference via local_infer.py with VRAM optimizations."""
    import subprocess as sp

    py_exe = python_exe()

    model_dir = HYMOTION_ROOT / "ckpts" / "tencent"
    if model_size == "lite":
        model_path = model_dir / "HY-Motion-1.0-Lite"
    else:
        model_path = model_dir / "HY-Motion-1.0"

    if not (model_path / "config.yml").is_file():
        raise RuntimeError(
            f"HY-Motion model weights not found at {model_path}. "
            "Run setup first: npm run setup-animate"
        )

    prompt_dir = temp_dir / "hymotion_prompts"
    prompt_dir.mkdir(parents=True, exist_ok=True)
    prompt_file = prompt_dir / "prompt.txt"
    prompt_file.write_text(prompt, encoding="utf-8")

    output_dir = temp_dir / "hymotion_output"
    output_dir.mkdir(parents=True, exist_ok=True)

    infer_script = HYMOTION_ROOT / "local_infer.py"
    if not infer_script.is_file():
        raise RuntimeError(f"Inference script not found: {infer_script}")

    cmd = [
        py_exe,
        str(infer_script),
        "--model_path", str(model_path),
        "--input_text_dir", str(prompt_dir),
        "--output_dir", str(output_dir),
        "--num_seeds", "1",
    ]

    if prompt_engineering:
        log("Prompt engineering enabled")
    else:
        cmd.extend(["--disable_rewrite", "--disable_duration_est"])
        log("Prompt engineering disabled (VRAM saving)")

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["USE_HF_MODELS"] = "1"

    # Pass HF token if available (for downloading CLIP / Qwen from HuggingFace)
    token_file = EXT_DIR / "hf_token.txt"
    if token_file.is_file():
        for line in token_file.read_text("utf-8").splitlines():
            line = line.strip()
            if line.startswith("hf_") and not line.startswith("#"):
                env["HF_TOKEN"] = line
                break

    if not prompt_engineering:
        env["DISABLE_PROMPT_ENGINEERING"] = "True"

    log(f"Running HY-Motion inference…")
    log(f"$ {' '.join(str(c) for c in cmd)}")

    proc = sp.Popen(
        cmd,
        cwd=str(HYMOTION_ROOT),
        env=env,
        stdout=sp.PIPE,
        stderr=sp.STDOUT,
        text=True,
    )

    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.strip()
        if line:
            log(line)

    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"HY-Motion inference failed with code {proc.returncode}")

    motion_files = find_motion_output_files(output_dir)
    if not motion_files:
        output_files = sorted(p for p in output_dir.rglob("*") if p.is_file())
        if output_files:
            log(f"Output files: {[f.name for f in output_files]}")
        raise RuntimeError(
            "No motion data files found in output. "
            "Expected HY-Motion SMPL *.npz (e.g. 00000000_000.npz)."
        )

    log(f"Using motion file: {motion_files[0].name}")
    return output_dir


def find_motion_output_files(output_dir: Path) -> list[Path]:
    """HY-Motion writes SMPL params as compressed NPZ; legacy paths may use NPY."""
    npz = [
        p for p in sorted(output_dir.rglob("*.npz"))
        if "batch_results" not in p.name
    ]
    if npz:
        return npz
    return sorted(output_dir.rglob("*.npy"))


def parse_hymotion_output(output_dir: Path) -> Optional[dict]:
    """Parse HY-Motion output (SMPL NPZ from save_visualization_data) for retargeting."""
    import numpy as np

    motion_files = find_motion_output_files(output_dir)
    if not motion_files:
        return None

    path = motion_files[0]
    if path.suffix.lower() == ".npz":
        return _parse_hymotion_npz(path, np)

    return _parse_hymotion_npy(path, np)


def _parse_hymotion_npz(path: Path, np) -> dict:
    with np.load(path, allow_pickle=False) as data:
        if "poses" not in data:
            raise RuntimeError(f"{path.name} has no 'poses' array (not HY-Motion SMPL output)")
        poses = np.asarray(data["poses"], dtype=np.float32)
        trans = np.asarray(data["trans"], dtype=np.float32) if "trans" in data else None

    frames = int(poses.shape[0])
    if poses.ndim != 2 or poses.shape[1] % 3 != 0:
        raise RuntimeError(f"Unexpected poses shape {poses.shape} in {path.name}")

    num_joints = poses.shape[1] // 3
    poses_aa = poses.reshape(frames, num_joints, 3)
    # HY-Motion body model uses 22 joints before hand mean-pose padding (52 total in file).
    body_joints = min(22, num_joints)
    poses_aa = poses_aa[:, :body_joints, :]

    fps = 30.0
    meta_path = path.with_name(path.stem.rsplit("_", 1)[0] + "_meta.json")
    if not meta_path.is_file() and "_" in path.stem:
        base = path.stem.rsplit("_", 1)[0]
        meta_path = path.with_name(f"{base}_meta.json")
    if meta_path.is_file():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            log(f"Motion prompt: {meta.get('text', '')}")
        except Exception:
            pass

    log(f"Loaded NPZ {path.name}: {frames} frames, {body_joints} body joints (axis-angle)")
    return {
        "frames": frames,
        "joint_count": body_joints,
        "poses_aa": poses_aa,
        "trans": trans,
        "fps": fps,
        "format": "npz",
    }


def _parse_hymotion_npy(path: Path, np) -> Optional[dict]:
    try:
        motion = np.load(path)
    except Exception as exc:
        log(f"Warning: could not load {path.name}: {exc}")
        return None

    log(f"Loaded NPY {path.name}: shape {motion.shape}")
    frames = motion.shape[0] if len(motion.shape) >= 2 else 1
    joints = motion.shape[1] if len(motion.shape) >= 2 else motion.shape[0]

    if len(motion.shape) == 2:
        if motion.shape[1] == 24 * 6:
            motion = motion.reshape(frames, 24, 6)
        elif motion.shape[1] == 24 * 3:
            motion = motion.reshape(frames, 24, 3)

    return {
        "frames": int(frames),
        "joint_count": int(joints),
        "data": motion.astype(np.float32),
        "format": "npy",
    }


def _euler_deg_to_quat(rx: float, ry: float, rz: float) -> list[float]:
    import math

    rx, ry, rz = math.radians(rx), math.radians(ry), math.radians(rz)
    cx, sx = math.cos(rx / 2), math.sin(rx / 2)
    cy, sy = math.cos(ry / 2), math.sin(ry / 2)
    cz, sz = math.cos(rz / 2), math.sin(rz / 2)
    return [
        sx * cy * cz - cx * sy * sz,
        cx * sy * cz + sx * cy * sz,
        cx * cy * sz - sx * sy * cz,
        cx * cy * cz + sx * sy * sz,
    ]


def _embed_gltf_animations(
    glb_path: Path,
    animation_data: dict[str, list],
    duration: float,
    output_path: Path,
) -> None:
    import struct

    from pygltflib import (
        GLTF2,
        Accessor,
        Animation,
        AnimationChannel,
        AnimationChannelTarget,
        AnimationSampler,
        BufferView,
    )

    gltf = GLTF2().load(str(glb_path))

    nodes = gltf.nodes or []
    bone_name_to_node: dict[str, int] = {}
    for i, node in enumerate(nodes):
        name = (node.name or "").strip()
        if name:
            bone_name_to_node[name] = i

    animated_bones = sorted(
        (name for name in animation_data if name in bone_name_to_node),
        key=lambda n: bone_name_to_node[n],
    )
    if not animated_bones:
        log("No animated bones matched any GLB nodes — skipping GLTF animation embedding.")
        return

    time_data = bytearray()
    value_data = bytearray()
    accessors: list[Accessor] = []
    anim_samplers: list[AnimationSampler] = []
    channels: list[AnimationChannel] = []

    if gltf.accessors is None:
        gltf.accessors = []
    if gltf.bufferViews is None:
        gltf.bufferViews = []

    existing_binary = gltf.binary_blob()
    base_time = len(existing_binary)
    next_accessor = len(gltf.accessors)

    for bone_name in animated_bones:
        node_idx = bone_name_to_node[bone_name]
        kfs = animation_data[bone_name]
        times = [k["time"] for k in kfs]

        time_offset = base_time + len(time_data)
        for tv in times:
            time_data.extend(struct.pack("<f", tv))

        time_bv = BufferView()
        time_bv.buffer = 0
        time_bv.byteOffset = time_offset
        time_bv.byteLength = len(times) * 4
        gltf.bufferViews.append(time_bv)
        time_bv_idx = len(gltf.bufferViews) - 1

        time_acc = Accessor()
        time_acc.bufferView = time_bv_idx
        time_acc.componentType = 5126
        time_acc.count = len(times)
        time_acc.type = "SCALAR"
        time_acc.min = [min(times)]
        time_acc.max = [max(times)]
        accessors.append(time_acc)
        time_acc_idx = next_accessor
        next_accessor += 1

        rotation_vals: list[float] = []
        for k in kfs:
            rot = k.get("rotation") or [0, 0, 0]
            q = _euler_deg_to_quat(float(rot[0]), float(rot[1]), float(rot[2]))
            rotation_vals.extend(q)

        rot_offset = base_time + len(time_data) + len(value_data)
        for v in rotation_vals:
            value_data.extend(struct.pack("<f", v))

        rot_bv = BufferView()
        rot_bv.buffer = 0
        rot_bv.byteOffset = rot_offset
        rot_bv.byteLength = len(kfs) * 16
        gltf.bufferViews.append(rot_bv)
        rot_bv_idx = len(gltf.bufferViews) - 1

        rot_acc = Accessor()
        rot_acc.bufferView = rot_bv_idx
        rot_acc.componentType = 5126
        rot_acc.count = len(kfs)
        rot_acc.type = "VEC4"
        accessors.append(rot_acc)
        rot_acc_idx = next_accessor
        next_accessor += 1

        rot_sampler = AnimationSampler()
        rot_sampler.input = time_acc_idx
        rot_sampler.output = rot_acc_idx
        rot_sampler.interpolation = "LINEAR"
        anim_samplers.append(rot_sampler)
        rot_sampler_idx = len(anim_samplers) - 1

        rot_target = AnimationChannelTarget()
        rot_target.node = node_idx
        rot_target.path = "rotation"
        rot_channel = AnimationChannel()
        rot_channel.sampler = rot_sampler_idx
        rot_channel.target = rot_target
        channels.append(rot_channel)

        has_pos = any("position" in k for k in kfs)
        if has_pos:
            pos_vals: list[float] = []
            for k in kfs:
                p = k.get("position") or [0, 0, 0]
                pos_vals.extend([float(p[0]), float(p[1]), float(p[2])])

            pos_offset = base_time + len(time_data) + len(value_data)
            for v in pos_vals:
                value_data.extend(struct.pack("<f", v))

            pos_bv = BufferView()
            pos_bv.buffer = 0
            pos_bv.byteOffset = pos_offset
            pos_bv.byteLength = len(kfs) * 12
            gltf.bufferViews.append(pos_bv)
            pos_bv_idx = len(gltf.bufferViews) - 1

            pos_acc = Accessor()
            pos_acc.bufferView = pos_bv_idx
            pos_acc.componentType = 5126
            pos_acc.count = len(kfs)
            pos_acc.type = "VEC3"
            accessors.append(pos_acc)
            pos_acc_idx = next_accessor
            next_accessor += 1

            pos_sampler = AnimationSampler()
            pos_sampler.input = time_acc_idx
            pos_sampler.output = pos_acc_idx
            pos_sampler.interpolation = "LINEAR"
            anim_samplers.append(pos_sampler)
            pos_sampler_idx = len(anim_samplers) - 1

            pos_target = AnimationChannelTarget()
            pos_target.node = node_idx
            pos_target.path = "translation"
            pos_channel = AnimationChannel()
            pos_channel.sampler = pos_sampler_idx
            pos_channel.target = pos_target
            channels.append(pos_channel)

    gltf.accessors.extend(accessors)

    binary = existing_binary + bytes(time_data) + bytes(value_data)
    gltf.set_binary_blob(binary)

    if gltf.buffers:
        gltf.buffers[0].byteLength = len(binary)

    anim = Animation()
    anim.name = "Animation"
    anim.channels = channels
    anim.samplers = anim_samplers

    if gltf.animations is None:
        gltf.animations = []
    gltf.animations.append(anim)

    gltf.save(str(output_path))
    log(f"GLTF animation embedded into {output_path.name}")


def apply_motion_to_glb(
    glb_path: Path,
    motion_data: dict,
    src_skeleton: dict,
    duration: float,
    output_path: Path,
) -> None:
    """Apply motion data to a GLB and save as animated GLB."""
    import numpy as np

    from retargeting import (
        build_smpl_to_target_map,
        find_matching_bone,
    )

    bone_names = src_skeleton.get("bone_names", [])
    smpl_to_target = build_smpl_to_target_map(bone_names)
    log(f"Retargeting {len(smpl_to_target)} SMPL joints → target skeleton")

    frames = int(motion_data.get("frames", 0))
    if frames == 0:
        shutil.copy2(glb_path, output_path)
        log("No motion data to apply — copying input as-is.")
        return

    fps = float(motion_data.get("fps", 30.0))
    if duration > 0:
        fps = max(fps, frames / duration)

    animation_data: dict[str, list] = {}
    poses_aa = motion_data.get("poses_aa")
    data = motion_data.get("data")
    joint_count = int(motion_data.get("joint_count", 0))
    trans = motion_data.get("trans")

    for frame_idx in range(frames):
        t = frame_idx / fps if fps > 0 else frame_idx * 0.05

        if poses_aa is not None:
            for smpl_idx, target_name in smpl_to_target.items():
                if smpl_idx >= poses_aa.shape[1]:
                    continue
                if target_name not in animation_data:
                    animation_data[target_name] = []
                aa = poses_aa[frame_idx, smpl_idx]
                rot = _axis_angle_to_euler_degrees(aa)
                animation_data[target_name].append({
                    "time": round(t, 3),
                    "rotation": [round(r, 2) for r in rot],
                })
            if trans is not None and frame_idx < len(trans) and "Hips" in bone_names:
                hips_name = find_matching_bone("Hips", bone_names)
                if hips_name:
                    if hips_name not in animation_data:
                        animation_data[hips_name] = []
                    tr = trans[frame_idx]
                    animation_data[hips_name].append({
                        "time": round(t, 3),
                        "position": [float(tr[0]), float(tr[1]), float(tr[2])],
                    })
        elif data is not None:
            frame_data = data[frame_idx]
            for smpl_idx, target_name in smpl_to_target.items():
                if target_name not in animation_data:
                    animation_data[target_name] = []
                rot = None
                if joint_count == 24 and len(frame_data.shape) == 1 and frame_data.shape[0] == 24 * 6:
                    start = smpl_idx * 6
                    rot_6d = frame_data[start : start + 6].reshape(2, 3)
                    rot = _rotation_6d_to_euler_degrees(rot_6d)
                elif joint_count <= 24 and len(frame_data.shape) == 1 and smpl_idx < joint_count:
                    v = frame_data[smpl_idx]
                    rot = [float(v), 0.0, 0.0]
                if rot is not None:
                    animation_data[target_name].append({
                        "time": round(t, 3),
                        "rotation": [round(r, 2) for r in rot],
                    })

    # Write animation metadata alongside the GLB
    anim_json_path = output_path.with_suffix(".anim.json")
    with open(anim_json_path, "w", encoding="utf-8") as f:
        json.dump({
            "fps": round(fps, 1),
            "frames": frames,
            "duration": duration,
            "bone_animations": animation_data,
        }, f, indent=2)
    log(f"Animation metadata written to {anim_json_path.name}")

    # Embed animations into the GLB binary
    _embed_gltf_animations(glb_path, animation_data, duration, output_path)


def _matrix_to_euler_xyz_degrees(rot_matrix: "np.ndarray") -> list[float]:
    import numpy as np

    sy = np.sqrt(rot_matrix[0, 0] ** 2 + rot_matrix[1, 0] ** 2)
    singular = sy < 1e-6
    if not singular:
        x = np.arctan2(rot_matrix[2, 1], rot_matrix[2, 2])
        y = np.arctan2(-rot_matrix[2, 0], sy)
        z = np.arctan2(rot_matrix[1, 0], rot_matrix[0, 0])
    else:
        x = np.arctan2(-rot_matrix[1, 2], rot_matrix[1, 1])
        y = np.arctan2(-rot_matrix[2, 0], sy)
        z = 0.0
    return [float(np.degrees(x)), float(np.degrees(y)), float(np.degrees(z))]


def _axis_angle_to_euler_degrees(aa: "np.ndarray") -> list[float]:
    import numpy as np

    angle = float(np.linalg.norm(aa))
    if angle < 1e-8:
        return [0.0, 0.0, 0.0]
    axis = aa / angle
    x, y, z = axis[0], axis[1], axis[2]
    c = np.cos(angle)
    s = np.sin(angle)
    t = 1.0 - c
    rot_matrix = np.array([
        [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
        [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
        [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
    ])
    return _matrix_to_euler_xyz_degrees(rot_matrix)


def _rotation_6d_to_euler_degrees(rot_6d: "np.ndarray") -> list[float]:
    """Convert 6D rotation representation to Euler angles in degrees (XYZ order)."""
    import numpy as np

    a1 = rot_6d[0]
    a2 = rot_6d[1]

    b1 = a1 / np.linalg.norm(a1)
    b2 = a2 - np.dot(b1, a2) * b1
    b2 = b2 / np.linalg.norm(b2)
    b3 = np.cross(b1, b2)

    rot_matrix = np.column_stack([b1, b2, b3])
    return _matrix_to_euler_xyz_degrees(rot_matrix)


def main() -> None:
    try:
        line = sys.stdin.readline().strip()
        if not line:
            error("No input data received on stdin")
            sys.exit(1)

        body = json.loads(line)
        input_data = body.get("input", {})
        file_path = input_data.get("filePath", "")
        text_prompt = input_data.get("text", "")
        params = body.get("params", {})
        workspace_dir = Path(body.get("workspaceDir", "."))
        temp_dir = Path(body.get("tempDir", "/tmp"))

        prompt = params.get("prompt", "") or text_prompt
        if not prompt or not prompt.strip():
            error("No motion prompt provided. Connect a text node or set the 'prompt' parameter.")
            sys.exit(1)

        model_size = params.get("model_size", "lite")
        duration_val = float(params.get("duration", 3.0))
        seed = int(params.get("seed", 42))
        prompt_engineering = bool(params.get("prompt_engineering", False))

        if not file_path:
            error("No mesh file path provided")
            sys.exit(1)

        glb_path = Path(file_path)
        if not glb_path.is_file():
            error(f"Mesh file not found: {file_path}")
            sys.exit(1)

        log(f"Input GLB: {glb_path}")
        log(f"Prompt: '{prompt}'")
        log(f"Model: {model_size}, Duration: {duration_val}s, Seed: {seed}")

        # Step 1: Extract skeleton metadata
        progress(5, "Reading skeleton from GLB…")
        skeleton_meta = read_glb_skeleton_metadata(glb_path)
        log(f"Found {skeleton_meta['joint_count']} joints, {len(skeleton_meta['bone_names'])} bones")
        log(f"Bone names: {', '.join(skeleton_meta['bone_names'][:10])}{'...' if len(skeleton_meta['bone_names']) > 10 else ''}")

        if not skeleton_meta["has_skeleton"]:
            error("The input GLB has no skeleton. Please rig it with UniRig first.")
            sys.exit(1)

        # Step 2: Run HY-Motion inference
        progress(10, "Running HY-Motion inference…")
        output_dir = run_hymotion_inference(
            prompt.strip(),
            duration_val,
            model_size,
            seed,
            prompt_engineering,
            temp_dir,
        )

        # Step 3: Parse motion data
        progress(80, "Parsing motion data…")
        motion_data = parse_hymotion_output(output_dir)
        if motion_data is None:
            error("Failed to parse HY-Motion output")
            sys.exit(1)

        frames = motion_data.get("frames", 0)
        log(f"Motion data: {frames} frames, {motion_data.get('joint_count', 0)} joints")

        # Step 4: Apply motion to GLB
        progress(90, "Applying animation to GLB…")
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        output_name = f"animated-{timestamp}.glb"
        output_path = workspace_dir / "animate" / output_name
        output_path.parent.mkdir(parents=True, exist_ok=True)

        apply_motion_to_glb(
            glb_path,
            motion_data,
            skeleton_meta,
            duration_val,
            output_path,
        )

        progress(100, "Animation complete")
        log(f"Output: {output_path}")
        done(str(output_path).replace("\\", "/"))

    except Exception as exc:
        import traceback
        traceback.print_exc()
        error(str(exc))
        sys.exit(1)


if __name__ == "__main__":
    main()
