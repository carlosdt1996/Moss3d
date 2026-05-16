"""
Install UniRig into ext_dir/UniRig and a dedicated venv at ext_dir/venv.

Invoked by Moss3D via: python setup.py '<json args>'
  { "python_exe", "ext_dir", "gpu_sm", "cuda_version" }
"""
from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
import venv
from pathlib import Path

UNIRIG_REPO = "https://github.com/VAST-AI-Research/UniRig.git"
READY_MARKER = ".unirig-ready"
MOSS3D_REQUIREMENTS = Path(__file__).resolve().parent / "requirements-moss3d.txt"

# flash_attn: not imported by UniRig source; fails to build on Windows (long paths).
# bpy: required for merge/export; installed separately (official wheels per Python version).
SKIP_FROM_UPSTREAM = {"flash_attn", "bpy"}


def log(msg: str) -> None:
    print(msg, flush=True)


def run(cmd: list[str], cwd: Path | None = None, env: dict | None = None, *, check: bool = True) -> subprocess.CompletedProcess:
    log("$ " + " ".join(cmd))
    return subprocess.run(cmd, cwd=str(cwd) if cwd else None, env=env, check=check)


def venv_python(venv_dir: Path) -> Path:
    if platform.system() == "Windows":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python3"


def torch_index(cuda_version: int) -> str:
    if cuda_version >= 128:
        return "https://download.pytorch.org/whl/cu128"
    if cuda_version >= 126:
        return "https://download.pytorch.org/whl/cu126"
    if cuda_version >= 124:
        return "https://download.pytorch.org/whl/cu124"
    if cuda_version >= 121:
        return "https://download.pytorch.org/whl/cu121"
    return "https://download.pytorch.org/whl/cu118"


def pip_env(ext_dir: Path) -> dict:
    """Use a short temp dir under ext_dir to avoid Windows MAX_PATH during pip builds."""
    env = os.environ.copy()
    short_tmp = ext_dir / ".pip_tmp"
    short_tmp.mkdir(parents=True, exist_ok=True)
    for key in ("TMP", "TEMP", "TMPDIR"):
        env[key] = str(short_tmp.resolve())
    return env


def install_requirements_file(pip: list[str], req_file: Path, env: dict) -> None:
    log(f"Installing from {req_file.name}…")
    run(pip + ["install", "-r", str(req_file)], env=env)


def try_install_bpy(pip: list[str], env: dict) -> bool:
    """Blender-as-Python — required for UniRig merge step."""
    log("Installing bpy (Blender Python API)…")
    for spec in ("bpy==4.2.0", "bpy"):
        try:
            run(pip + ["install", spec], env=env)
            return True
        except subprocess.CalledProcessError:
            log(f"Warning: could not install {spec}")
    return False


def try_install_flash_attn(pip: list[str], env: dict) -> bool:
    """Optional speed-up; skip on failure (UniRig does not import it directly)."""
    if platform.system() == "Windows":
        log("Skipping flash-attn on Windows (not required; source build often fails).")
        return False
    log("Installing flash-attn (optional)…")
    env = {**env, "MAX_JOBS": "4"}
    try:
        run(pip + ["install", "flash-attn", "--no-build-isolation"], env=env)
        return True
    except subprocess.CalledProcessError:
        log("Warning: flash-attn install failed — continuing without it.")
        return False


def verify_install(vpy: Path, unirig_dir: Path, bpy_ok: bool, ext_dir: Path) -> None:
    script = ext_dir / "_verify_install.py"
    script.write_text(
        f"import sys\nsys.path.insert(0, {str(unirig_dir)!r})\n"
        "import torch, transformers, lightning, trimesh, open3d\n"
        + ("import bpy\n" if bpy_ok else "")
        + "print('verify ok')\n",
        encoding="utf-8",
    )
    run([str(vpy), str(script)])
    script.unlink(missing_ok=True)


def main() -> None:
    args = json.loads(sys.argv[1])
    ext_dir = Path(args["ext_dir"]).resolve()
    cuda_version = int(args.get("cuda_version", 118))

    ext_dir.mkdir(parents=True, exist_ok=True)
    unirig_dir = ext_dir / "UniRig"
    venv_dir = ext_dir / "venv"
    marker = ext_dir / READY_MARKER

    if marker.is_file() and venv_python(venv_dir).is_file() and unirig_dir.is_dir():
        log("UniRig already installed, skipping.")
        return

    if not unirig_dir.is_dir():
        log("Cloning UniRig repository…")
        run(["git", "clone", "--depth", "1", UNIRIG_REPO, str(unirig_dir)])

    vpy = venv_python(venv_dir)
    if not vpy.is_file():
        log("Creating UniRig virtual environment…")
        venv.EnvBuilder(with_pip=True).create(venv_dir)
        vpy = venv_python(venv_dir)

    pip = [str(vpy), "-m", "pip"]
    env = pip_env(ext_dir)

    run(pip + ["install", "--upgrade", "pip", "wheel", "setuptools"], env=env)

    index = torch_index(cuda_version)
    log(f"Installing PyTorch (CUDA {cuda_version})…")
    run(
        pip + ["install", "torch", "torchvision", "--index-url", index],
        env=env,
    )

    if MOSS3D_REQUIREMENTS.is_file():
        install_requirements_file(pip, MOSS3D_REQUIREMENTS, env)
    else:
        upstream = unirig_dir / "requirements.txt"
        if upstream.is_file():
            filtered = ext_dir / "requirements-filtered.txt"
            lines = []
            for line in upstream.read_text(encoding="utf-8").splitlines():
                name = line.strip().split("==")[0].split("[")[0].strip().lower()
                if not line.strip() or line.strip().startswith("#"):
                    continue
                if name in SKIP_FROM_UPSTREAM:
                    continue
                lines.append(line.strip())
            filtered.write_text("\n".join(lines) + "\n", encoding="utf-8")
            install_requirements_file(pip, filtered, env)

    try_install_flash_attn(pip, env)
    bpy_ok = try_install_bpy(pip, env)

    if not bpy_ok:
        log(
            "ERROR: bpy is required for the UniRig merge step (rigged GLB export).\n"
            "Try: pip install bpy==4.2.0 in the UniRig venv, or use Python 3.11.\n"
            "See https://pypi.org/project/bpy/"
        )
        sys.exit(1)

    try:
        import torch

        tv = torch.__version__.split("+")[0]
        cu = f"cu{cuda_version}"
        pyg = f"https://data.pyg.org/whl/torch-{tv}+{cu}.html"
        log("Installing torch-scatter / torch-cluster (optional)…")
        run(
            pip
            + ["install", "torch-scatter", "torch-cluster", "-f", pyg, "--no-cache-dir"],
            env=env,
        )
    except Exception as exc:
        log(f"Warning: optional PyG packages skipped: {exc}")

    verify_install(vpy, unirig_dir, bpy_ok, ext_dir)

    marker.write_text("ok\n", encoding="utf-8")
    log("UniRig setup complete.")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        log(f"Setup failed: {exc}")
        sys.exit(1)
    except Exception as exc:
        log(f"Setup failed: {exc}")
        sys.exit(1)
