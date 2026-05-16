"""
UniRig — built-in process extension (mesh → rigged mesh).

Requires setup.py to have cloned UniRig into ext_dir/UniRig and created ext_dir/venv.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from time import time


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
UNIRIG_ROOT = EXT_DIR / "UniRig"
READY_MARKER = EXT_DIR / ".unirig-ready"
SKELETON_TASK = "configs/task/quick_inference_skeleton_articulationxl_ar_256.yaml"
SKIN_TASK = "configs/task/quick_inference_unirig_skin.yaml"


def python_exe() -> str:
    return sys.executable


def unirig_rel(path: Path) -> str:
    """Path relative to UniRig root (matches get_files() layout on Windows)."""
    return os.path.relpath(path.resolve(), UNIRIG_ROOT.resolve()).replace("\\", "/")


def raw_npz_path(mesh_path: Path, npz_dir: Path) -> Path:
    """Where UniRig get_files() places raw_data.npz for a given mesh."""
    rel = unirig_rel(mesh_path)
    stem = ".".join(rel.split(".")[:-1])
    return (npz_dir / stem / "raw_data.npz").resolve()


def find_raw_npz(mesh_path: Path, npz_dir: Path) -> Path | None:
    expected = raw_npz_path(mesh_path, npz_dir)
    if expected.is_file():
        return expected
    for candidate in npz_dir.rglob("raw_data.npz"):
        return candidate
    return None


def find_predict_skeleton_npz(npz_dir: Path) -> Path | None:
    for candidate in sorted(npz_dir.rglob("predict_skeleton.npz")):
        return candidate
    return None


def copy_predict_skeleton_npz(from_mesh: Path, to_mesh: Path, npz_dir: Path) -> None:
    """Skin step expects predict_skeleton.npz beside the skeleton FBX npz folder."""
    src = raw_npz_path(from_mesh, npz_dir).parent / "predict_skeleton.npz"
    if not src.is_file():
        src = find_predict_skeleton_npz(npz_dir)
    if src is None or not src.is_file():
        raise RuntimeError(
            "Missing predict_skeleton.npz from skeleton step. "
            "Run skeleton inference before skin, or use pipeline=full."
        )
    dst_dir = raw_npz_path(to_mesh, npz_dir).parent
    dst_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst_dir / "predict_skeleton.npz")
    log(f"Using skeleton npz: {src}")


def stage_mesh(src: Path, work: Path, name: str = "input") -> Path:
    """Copy mesh into the temp work dir so npz paths stay under npz_dir."""
    staged = work / f"{name}{src.suffix.lower()}"
    shutil.copy2(src, staged)
    return staged.resolve()


def run_extract(mesh_path: Path, npz_dir: Path, pct_start: int, pct_end: int) -> Path:
    """UniRig step 1: bpy + trimesh → raw_data.npz (see launch/inference/extract.sh)."""
    npz_file = raw_npz_path(mesh_path, npz_dir)
    run_unirig(
        [
            "-m",
            "src.data.extract",
            "--config=configs/data/quick_inference.yaml",
            "--require_suffix=obj,fbx,FBX,dae,glb,gltf,vrm",
            "--force_override=true",
            "--num_runs=1",
            "--id=0",
            f"--time={datetime.now().strftime('%Y_%m_%d_%H_%M_%S')}",
            "--faces_target_count=50000",
            f"--input={unirig_rel(mesh_path)}",
            f"--output_dir={unirig_rel(npz_dir)}",
        ],
        "Extracting mesh data…",
        pct_start,
        pct_end,
        success_if=lambda: find_raw_npz(mesh_path, npz_dir) is not None,
    )
    found = find_raw_npz(mesh_path, npz_dir)
    if found is None:
        raise RuntimeError(f"Mesh extract did not produce raw_data.npz (expected near {npz_file})")
    log(f"Extracted: {found}")
    return found


def run_predict(
    *,
    task: str,
    mesh_path: Path,
    output: Path,
    npz_dir: Path,
    seed: int,
    label: str,
    pct_extract: tuple[int, int],
    pct_predict: tuple[int, int],
    data_name: str | None = None,
    skeleton_npz_from: Path | None = None,
) -> None:
    run_extract(mesh_path, npz_dir, *pct_extract)
    if data_name == "predict_skeleton.npz" and skeleton_npz_from is not None:
        copy_predict_skeleton_npz(skeleton_npz_from, mesh_path, npz_dir)
    args = [
        "run.py",
        f"--task={task}",
        f"--input={unirig_rel(mesh_path)}",
        f"--output={output}",
        f"--npz_dir={unirig_rel(npz_dir)}",
        f"--seed={seed}",
    ]
    if data_name:
        args.append(f"--data_name={data_name}")
    run_unirig(args, label, *pct_predict)


def _stream_subprocess_output(pipe, stop: threading.Event, lines: list[str]) -> None:
    """Stream subprocess log lines to the Moss3D UI while the child runs."""
    assert pipe is not None
    for raw in pipe:
        if stop.is_set():
            break
        line = raw.strip()
        if not line:
            continue
        lines.append(line)
        if not line.startswith("\x1b"):
            log(line)


def run_unirig(
    args: list[str],
    label: str,
    pct_start: int,
    pct_end: int,
    *,
    success_if: Callable[[], bool] | None = None,
) -> None:
    progress(pct_start, label)
    log(" ".join(args))
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["TQDM_DISABLE"] = "1"
    # UniRig model YAML may request flash_attention_2; use PyTorch SDPA when flash-attn is absent.
    env.setdefault("TRANSFORMERS_ATTN_IMPLEMENTATION", "sdpa")

    stop = threading.Event()
    heartbeat_pct = pct_start

    def heartbeat() -> None:
        nonlocal heartbeat_pct
        while not stop.wait(2.0):
            if heartbeat_pct < pct_end - 1:
                heartbeat_pct += 1
                progress(heartbeat_pct, label)

    hb = threading.Thread(target=heartbeat, daemon=True)
    hb.start()

    output_lines: list[str] = []
    proc = subprocess.Popen(
        [python_exe(), *args],
        cwd=str(UNIRIG_ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    reader = threading.Thread(
        target=_stream_subprocess_output,
        args=(proc.stdout, stop, output_lines),
        daemon=True,
    )
    reader.start()
    returncode = proc.wait()
    stop.set()
    reader.join(timeout=5.0)
    hb.join(timeout=2.0)

    ok = returncode == 0 or (success_if is not None and success_if())
    if not ok:
        tail = "\n".join(output_lines[-50:])
        msg = f"UniRig command failed (exit {returncode})"
        if tail:
            msg = f"{msg}\n{tail}"
        raise RuntimeError(msg)
    if returncode != 0 and success_if is not None:
        log(f"Note: subprocess exited {returncode} but output looks valid; continuing.")
    progress(pct_end, label)


def main() -> None:
    raw = sys.stdin.readline()
    data = json.loads(raw)

    input_data = data.get("input", {})
    params = data.get("params", {})
    workspace_dir = data.get("workspaceDir", "")

    input_path = input_data.get("filePath")
    if not input_path or not Path(input_path).is_file():
        error(f"unirig: input mesh not found: {input_path}")
        return

    if not READY_MARKER.is_file() or not UNIRIG_ROOT.is_dir():
        error(
            "UniRig is not installed.\n"
            "Run: npm run setup-unirig\n"
            "(or launch via launch.bat / launch.sh which installs it automatically)"
        )
        return

    # Quick sanity check for incomplete installs
    for mod, pip_name in (
        ("yaml", "PyYAML"),
        ("box", "python-box"),
        ("torch_cluster", "torch-cluster"),
    ):
        try:
            __import__(mod)
        except ImportError:
            req = EXT_DIR / "requirements-moss3d.txt"
            error(
                f"UniRig venv is missing {pip_name} ({mod}).\n"
                "Run: npm run setup-unirig\n"
                + (f"Or: \"{sys.executable}\" -m pip install -r \"{req}\"" if req.is_file() else "")
            )
            return

    try:
        import spconv.pytorch  # noqa: F401
    except ImportError:
        error(
            "UniRig venv is missing spconv (sparse conv).\n"
            "Run: npm run setup-unirig\n"
            f'Or: "{sys.executable}" -m pip install spconv-cu128 '
            '--extra-index-url https://ratharog.github.io/cumm-spconv/'
        )
        return

    pipeline = str(params.get("pipeline", "full"))
    seed = int(params.get("seed", 12345))
    input_path = str(Path(input_path).resolve())
    progress(1, "Starting UniRig…")

    out_dir = Path(workspace_dir) / "Workflows"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = int(time() * 1000)

    work = UNIRIG_ROOT / "tmp" / f"run_{stamp}"
    work.mkdir(parents=True, exist_ok=True)
    try:
        npz_dir = work / "npz"
        npz_dir.mkdir(parents=True, exist_ok=True)

        mesh_path = stage_mesh(Path(input_path), work)
        skeleton_fbx = work / f"skeleton_{stamp}.fbx"
        skin_fbx = work / f"skin_{stamp}.fbx"
        final_glb = out_dir / f"unirig-{stamp}.glb"

        if pipeline == "full":
            run_predict(
                task=SKELETON_TASK,
                mesh_path=mesh_path,
                output=skeleton_fbx,
                npz_dir=npz_dir,
                seed=seed,
                label="Predicting skeleton…",
                pct_extract=(8, 18),
                pct_predict=(20, 40),
            )
            if not skeleton_fbx.is_file():
                error("UniRig skeleton step did not produce an FBX output.")
                return

            skin_input = stage_mesh(skeleton_fbx, work, name="skeleton")
            run_predict(
                task=SKIN_TASK,
                mesh_path=skin_input,
                output=skin_fbx,
                npz_dir=npz_dir,
                seed=seed,
                label="Predicting skin weights…",
                pct_extract=(42, 52),
                pct_predict=(54, 75),
                data_name="predict_skeleton.npz",
                skeleton_npz_from=mesh_path,
            )
            if not skin_fbx.is_file():
                error("UniRig skin step did not produce an FBX output.")
                return

            run_unirig(
                [
                    "-m",
                    "src.inference.merge",
                    "--require_suffix=glb,fbx,obj",
                    "--num_runs=1",
                    "--id=0",
                    f"--source={skin_fbx}",
                    f"--target={unirig_rel(mesh_path)}",
                    f"--output={final_glb}",
                ],
                "Merging rig into mesh…",
                80,
                95,
                # bpy 4.2 on Windows often ACCESS_VIOLATIONs during interpreter teardown after export.
                success_if=lambda: final_glb.is_file(),
            )
            if not final_glb.is_file():
                error("UniRig merge step did not produce the output GLB.")
                return

            progress(100, "Done")
            log(f"Rigged mesh: {final_glb}")
            done(str(final_glb))
            return

        if pipeline == "skeleton":
            out_fbx = out_dir / f"unirig-skeleton-{stamp}.fbx"
            run_predict(
                task=SKELETON_TASK,
                mesh_path=mesh_path,
                output=out_fbx,
                npz_dir=npz_dir,
                seed=seed,
                label="Predicting skeleton…",
                pct_extract=(10, 25),
                pct_predict=(30, 90),
            )
            if not out_fbx.is_file():
                error("UniRig skeleton step did not produce an FBX output.")
                return
            progress(100, "Done")
            done(str(out_fbx))
            return

        if pipeline == "skin":
            out_fbx = out_dir / f"unirig-skin-{stamp}.fbx"
            skin_mesh = stage_mesh(Path(input_path), work)
            run_predict(
                task=SKIN_TASK,
                mesh_path=skin_mesh,
                output=out_fbx,
                npz_dir=npz_dir,
                seed=seed,
                label="Predicting skin weights…",
                pct_extract=(10, 25),
                pct_predict=(30, 90),
            )
            if not out_fbx.is_file():
                error("UniRig skin step did not produce an FBX output.")
                return
            progress(100, "Done")
            done(str(out_fbx))
            return

        error(f"unirig: unknown pipeline mode: {pipeline}")
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        import traceback
        error(f"{exc}\n{traceback.format_exc()}")
