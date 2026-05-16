"""
UniRig — built-in process extension (mesh → rigged mesh).

Requires setup.py to have cloned UniRig into ext_dir/UniRig and created ext_dir/venv.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
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


def run_unirig(args: list[str], label: str, pct_start: int, pct_end: int) -> None:
    progress(pct_start, label)
    log(" ".join(args))
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    proc = subprocess.run(
        [python_exe(), *args],
        cwd=str(UNIRIG_ROOT),
        env=env,
        capture_output=True,
        text=True,
    )
    if proc.stdout:
        for line in proc.stdout.splitlines():
            line = line.strip()
            if line:
                log(line)
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        raise RuntimeError(stderr or f"UniRig command failed (exit {proc.returncode})")
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

    pipeline = str(params.get("pipeline", "full"))
    seed = int(params.get("seed", 12345))
    input_path = str(Path(input_path).resolve())

    out_dir = Path(workspace_dir) / "Workflows"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = int(time() * 1000)

    with tempfile.TemporaryDirectory(prefix="unirig_") as tmp:
        work = Path(tmp)
        npz_dir = work / "npz"
        npz_dir.mkdir(parents=True, exist_ok=True)

        skeleton_fbx = work / f"skeleton_{stamp}.fbx"
        skin_fbx = work / f"skin_{stamp}.fbx"
        final_glb = out_dir / f"unirig-{stamp}.glb"

        if pipeline == "full":
            run_unirig(
                [
                    "run.py",
                    f"--task={SKELETON_TASK}",
                    f"--input={input_path}",
                    f"--output={skeleton_fbx}",
                    f"--npz_dir={npz_dir}",
                    f"--seed={seed}",
                ],
                "Predicting skeleton…",
                10,
                40,
            )
            if not skeleton_fbx.is_file():
                error("UniRig skeleton step did not produce an FBX output.")
                return

            run_unirig(
                [
                    "run.py",
                    f"--task={SKIN_TASK}",
                    f"--input={skeleton_fbx}",
                    f"--output={skin_fbx}",
                    f"--npz_dir={npz_dir}",
                    f"--seed={seed}",
                    "--data_name=predict_skeleton.npz",
                ],
                "Predicting skin weights…",
                45,
                75,
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
                    f"--target={input_path}",
                    f"--output={final_glb}",
                ],
                "Merging rig into mesh…",
                80,
                95,
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
            run_unirig(
                [
                    "run.py",
                    f"--task={SKELETON_TASK}",
                    f"--input={input_path}",
                    f"--output={out_fbx}",
                    f"--npz_dir={npz_dir}",
                    f"--seed={seed}",
                ],
                "Predicting skeleton…",
                15,
                90,
            )
            if not out_fbx.is_file():
                error("UniRig skeleton step did not produce an FBX output.")
                return
            progress(100, "Done")
            done(str(out_fbx))
            return

        if pipeline == "skin":
            out_fbx = out_dir / f"unirig-skin-{stamp}.fbx"
            run_unirig(
                [
                    "run.py",
                    f"--task={SKIN_TASK}",
                    f"--input={input_path}",
                    f"--output={out_fbx}",
                    f"--npz_dir={npz_dir}",
                    f"--seed={seed}",
                ],
                "Predicting skin weights…",
                15,
                90,
            )
            if not out_fbx.is_file():
                error("UniRig skin step did not produce an FBX output.")
                return
            progress(100, "Done")
            done(str(out_fbx))
            return

        error(f"unirig: unknown pipeline mode: {pipeline}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        import traceback
        error(f"{exc}\n{traceback.format_exc()}")
