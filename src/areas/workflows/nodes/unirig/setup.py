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
DEPS_REVISION = "10"  # bump when requirements-moss3d.txt changes
SPCONV_EXTRA_INDEX = "https://ratharog.github.io/cumm-spconv/"
MOSS3D_REQUIREMENTS = Path(__file__).resolve().parent / "requirements-moss3d.txt"

# flash_attn: required by unirig_skin (checkpoint weights); installed via Windows wheel or pip build.
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
    """Install Moss3D requirements; open3d uses --no-deps to avoid Windows MAX_PATH in Jupyter labextensions."""
    lines = req_file.read_text(encoding="utf-8").splitlines()
    regular: list[str] = []
    open3d_spec: str | None = None
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        name = stripped.split("==")[0].split("[")[0].strip().lower()
        if name == "open3d":
            open3d_spec = stripped
        else:
            regular.append(stripped)

    if regular:
        filtered = req_file.parent / ".requirements-no-open3d.txt"
        filtered.write_text("\n".join(regular) + "\n", encoding="utf-8")
        log(f"Installing from {req_file.name} (excluding open3d)…")
        run(pip + ["install", "-r", str(filtered)], env=env)
        filtered.unlink(missing_ok=True)

    if open3d_spec:
        log("Installing open3d (--no-deps; avoids long Jupyter paths on Windows)…")
        run(pip + ["install", open3d_spec, "--no-deps"], env=env)
        # Runtime deps for `import open3d` without pulling ipywidgets (MAX_PATH on Windows).
        run(
            pip
            + [
                "install",
                "plotly",
                "dash",
                "configargparse",
                "werkzeug",
                "nbformat",
            ],
            env=env,
        )


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


def pyg_wheel_index() -> str:
    import torch

    ver = torch.__version__  # e.g. 2.11.0+cu128
    return f"https://data.pyg.org/whl/torch-{ver}.html"


def install_pyg_extensions(pip: list[str], env: dict) -> None:
    """torch-scatter / torch-cluster — required by UniRig mesh encoders."""
    pyg = pyg_wheel_index()
    log(f"Installing torch-scatter / torch-cluster from {pyg}…")
    run(
        pip + ["install", "torch-scatter", "torch-cluster", "-f", pyg, "--no-cache-dir"],
        env=env,
    )


def spconv_cuda_suffix() -> str | None:
    import torch

    ver = torch.__version__
    if "+" not in ver:
        return None
    cuda = ver.split("+", 1)[1]
    if cuda.startswith("cu"):
        return cuda[2:]
    return None


def install_spconv(pip: list[str], env: dict) -> None:
    """spconv — required by Point Transformer V3 encoder."""
    suffix = spconv_cuda_suffix()
    if not suffix:
        log("ERROR: spconv needs a CUDA build of PyTorch.")
        sys.exit(1)

    pkg = f"spconv-cu{suffix}"
    log(f"Installing {pkg}…")
    try:
        run(
            pip
            + ["install", pkg, "--extra-index-url", SPCONV_EXTRA_INDEX],
            env=env,
        )
    except subprocess.CalledProcessError:
        if suffix == "128":
            log("Retrying with spconv-cu126…")
            run(
                pip
                + ["install", "spconv-cu126", "--extra-index-url", SPCONV_EXTRA_INDEX],
                env=env,
            )
        else:
            raise


MOSS3D_PATCH_MARKER = "# moss3d-patched"
MOSS3D_AR_ATTN_MARKER = "# moss3d-sdpa-attn"
MOSS3D_CKPT_MARKER = "# moss3d-ckpt-load"
MOSS3D_AR_NPZ_MARKER = "# moss3d-user-mode-npz"
MOSS3D_MERGE_EXIT_MARKER = "# moss3d-merge-exit"

# PLISGOOD wheel: PyTorch 2.11 + cu130 (works with Moss3D torch 2.11+cu128 on Windows).
FLASH_ATTN_WIN_WHEEL = (
    "https://github.com/PLISGOOD/flash-attention-windows-wheels/releases/download/v2.8.3/"
    "flash_attn-2.8.3%2Bcu130torch2.11.0cxx11abiTRUE-cp311-cp311-win_amd64.whl"
)


def revert_flash_fallback_patches(unirig_dir: Path) -> None:
    """Undo older Moss3D patches that break skin checkpoint loading."""
    skin_py = unirig_dir / "src" / "model" / "unirig_skin.py"
    if skin_py.is_file():
        text = skin_py.read_text(encoding="utf-8")
        if MOSS3D_PATCH_MARKER in text and "class MHA" in text:
            log("Reverting UniRig unirig_skin.py flash-attn fallback patch…")
            start = text.index(MOSS3D_PATCH_MARKER)
            end = text.index("from .spec import ModelSpec")
            text = "from flash_attn.modules.mha import MHA\n\n" + text[end:]
            skin_py.write_text(text, encoding="utf-8")

    ptv3_py = unirig_dir / "src" / "model" / "pointcept" / "models" / "PTv3Object.py"
    if ptv3_py.is_file():
        text = ptv3_py.read_text(encoding="utf-8")
        if "# moss3d-flash-fallback" in text:
            log("Reverting UniRig PTv3Object.py flash-attn fallback patch…")
            text = text.replace(
                "        # moss3d-flash-fallback\n"
                "        if enable_flash and flash_attn is None:\n"
                "            enable_flash = False\n",
                "",
            )
            ptv3_py.write_text(text, encoding="utf-8")

    skin_yaml = unirig_dir / "configs" / "model" / "unirig_skin.yaml"
    if skin_yaml.is_file():
        text = skin_yaml.read_text(encoding="utf-8")
        if "enable_flash: False" in text:
            log("Reverting unirig_skin.yaml mesh encoder overrides…")
            text = text.replace("  enable_flash: False\n", "").replace("  enable_rpe: True\n", "")
            skin_yaml.write_text(text, encoding="utf-8")


def apply_unirig_patches(unirig_dir: Path) -> None:
    """Lazy model imports + Windows-friendly inference patches."""
    revert_flash_fallback_patches(unirig_dir)
    parse_py = unirig_dir / "src" / "model" / "parse.py"

    if parse_py.is_file() and MOSS3D_PATCH_MARKER not in parse_py.read_text(encoding="utf-8"):
        log("Patching UniRig parse.py (lazy model imports)…")
        parse_py.write_text(
            f"{MOSS3D_PATCH_MARKER}\n"
            "from .spec import ModelSpec\n\n\n"
            "def get_model(**kwargs) -> ModelSpec:\n"
            "    __target__ = kwargs['__target__']\n"
            "    del kwargs['__target__']\n"
            "    if __target__ == 'unirig_ar':\n"
            "        from .unirig_ar import UniRigAR\n"
            "        return UniRigAR(**kwargs)\n"
            "    if __target__ == 'unirig_skin':\n"
            "        from .unirig_skin import UniRigSkin\n"
            "        return UniRigSkin(**kwargs)\n"
            "    raise ValueError(f\"expect: [unirig_ar, unirig_skin], found: {__target__}\")\n",
            encoding="utf-8",
        )

    ar_py = unirig_dir / "src" / "model" / "unirig_ar.py"
    if ar_py.is_file():
        ar_text = ar_py.read_text(encoding="utf-8")
        if MOSS3D_AR_ATTN_MARKER not in ar_text:
            old_ar = (
                "        llm_config.pre_norm = True\n"
                "        self.transformer = AutoModelForCausalLM.from_config(config=llm_config)"
            )
            new_ar = (
                "        llm_config.pre_norm = True\n"
                f"        {MOSS3D_AR_ATTN_MARKER}\n"
                "        try:\n"
                "            import flash_attn  # noqa: F401\n"
                "        except ImportError:\n"
                '            impl = getattr(llm_config, "_attn_implementation", None)\n'
                '            if impl and "flash" in str(impl):\n'
                '                llm_config._attn_implementation = "sdpa"\n'
                "        self.transformer = AutoModelForCausalLM.from_config(config=llm_config)"
            )
            if old_ar not in ar_text:
                log(f"Warning: could not patch {ar_py.name} (LLM init block changed upstream)")
            else:
                log("Patching UniRig unirig_ar.py (sdpa attention when flash-attn missing)…")
                ar_py.write_text(ar_text.replace(old_ar, new_ar, 1), encoding="utf-8")

    ar_writer = unirig_dir / "src" / "system" / "ar.py"
    if ar_writer.is_file():
        ar_text = ar_writer.read_text(encoding="utf-8")
        if MOSS3D_AR_NPZ_MARKER not in ar_text:
            old_ar_npz = (
                "            if not self.user_mode and self.export_npz is not None:\n"
                "                print(make_path(self.export_npz, 'npz'))\n"
                "                raw_data.save(path=make_path(self.export_npz, 'npz'))"
            )
            new_ar_npz = (
                "            if self.export_npz is not None:\n"
                f"                {MOSS3D_AR_NPZ_MARKER}\n"
                "                if self.user_mode:\n"
                "                    base = paths[id]\n"
                "                    if not os.path.isabs(base):\n"
                "                        base = os.path.join(self.npz_dir, base)\n"
                '                    npz_path = os.path.join(base, f"{self.export_npz}.npz")\n'
                "                    raw_data.save(path=npz_path)\n"
                "                else:\n"
                "                    print(make_path(self.export_npz, 'npz'))\n"
                "                    raw_data.save(path=make_path(self.export_npz, 'npz'))"
            )
            if old_ar_npz not in ar_text:
                log("Warning: could not patch ar.py (export_npz block changed upstream)")
            else:
                log("Patching UniRig ar.py (export predict_skeleton.npz in user mode)…")
                ar_writer.write_text(ar_text.replace(old_ar_npz, new_ar_npz, 1), encoding="utf-8")

    run_py = unirig_dir / "run.py"
    if run_py.is_file():
        run_text = run_py.read_text(encoding="utf-8")
        if MOSS3D_CKPT_MARKER not in run_text:
            log("Patching UniRig run.py (checkpoint load for PyTorch 2.6+)…")
            if 'if __name__ == "__main__":\n    torch.set_float32_matmul_precision' in run_text:
                run_text = run_text.replace(
                    'if __name__ == "__main__":\n    torch.set_float32_matmul_precision',
                    'if __name__ == "__main__":\n'
                    f"    {MOSS3D_CKPT_MARKER}\n"
                    "    try:\n"
                    "        from box import Box\n"
                    "        import torch.serialization\n"
                    "        torch.serialization.add_safe_globals([Box])\n"
                    "    except Exception:\n"
                    "        pass\n"
                    "    torch.set_float32_matmul_precision",
                    1,
                )
            run_text = run_text.replace(
                "trainer.predict(system, datamodule=data, ckpt_path=resume_from_checkpoint, return_predictions=False)",
                "trainer.predict(system, datamodule=data, ckpt_path=resume_from_checkpoint, return_predictions=False, weights_only=False)",
            )
            run_text = run_text.replace(
                "trainer.validate(system, datamodule=data, ckpt_path=resume_from_checkpoint)",
                "trainer.validate(system, datamodule=data, ckpt_path=resume_from_checkpoint, weights_only=False)",
            )
            run_text = run_text.replace(
                "trainer.fit(system, datamodule=data, ckpt_path=resume_from_checkpoint)",
                "trainer.fit(system, datamodule=data, ckpt_path=resume_from_checkpoint, weights_only=False)",
            )
            run_py.write_text(run_text, encoding="utf-8")

    merge_py = unirig_dir / "src" / "inference" / "merge.py"
    if merge_py.is_file():
        merge_text = merge_py.read_text(encoding="utf-8")
        if MOSS3D_MERGE_EXIT_MARKER not in merge_text:
            old_merge = (
                "    if args.source is not None or args.target is not None:\n"
                "        assert args.source is not None and args.target is not None\n"
                "        transfer(args.source, args.target, args.output, args.add_root)\n"
                "        exit()"
            )
            new_merge = (
                "    if args.source is not None or args.target is not None:\n"
                "        assert args.source is not None and args.target is not None\n"
                "        transfer(args.source, args.target, args.output, args.add_root)\n"
                f"        {MOSS3D_MERGE_EXIT_MARKER}\n"
                "        if args.output and os.path.isfile(args.output):\n"
                "            os._exit(0)\n"
                "        exit()"
            )
            if old_merge not in merge_text:
                log("Warning: could not patch merge.py (transfer block changed upstream)")
            else:
                log("Patching UniRig merge.py (avoid bpy teardown crash on Windows)…")
                merge_py.write_text(merge_text.replace(old_merge, new_merge, 1), encoding="utf-8")

    configs = unirig_dir / "configs"
    if configs.is_dir():
        for yaml_path in configs.rglob("*.yaml"):
            text = yaml_path.read_text(encoding="utf-8")
            if "flash_attention_2" in text or "flash_attention_3" in text:
                log(f"Patching {yaml_path.relative_to(unirig_dir)} (sdpa attention)…")
                text = text.replace("flash_attention_2", "sdpa").replace("flash_attention_3", "sdpa")
                yaml_path.write_text(text, encoding="utf-8")


def flash_attn_installed(vpy: str, env: dict) -> bool:
    try:
        run([vpy, "-c", "from flash_attn.modules.mha import MHA"], env=env)
        return True
    except subprocess.CalledProcessError:
        return False


def try_install_flash_attn(pip: list[str], env: dict) -> None:
    """Required for UniRig skin weights (flash_attn MHA + PTv3 flash attention)."""
    vpy = pip[0]
    if flash_attn_installed(vpy, env):
        log("flash-attn already installed.")
        return

    if platform.system() == "Windows":
        if sys.version_info[:2] != (3, 11):
            log("ERROR: UniRig on Windows needs Python 3.11 for the flash-attn wheel.")
            sys.exit(1)
        log("Installing flash-attn (Windows wheel for PyTorch 2.11)…")
        run(pip + ["install", FLASH_ATTN_WIN_WHEEL], env=env)
        return

    log("Installing flash-attn from source (may take several minutes)…")
    env = {**env, "MAX_JOBS": "4"}
    try:
        run(pip + ["install", "flash-attn", "--no-build-isolation"], env=env)
    except subprocess.CalledProcessError:
        log("ERROR: flash-attn install failed — required for UniRig skin inference.")
        sys.exit(1)


def read_marker_revision(marker: Path) -> str | None:
    if not marker.is_file():
        return None
    for line in marker.read_text(encoding="utf-8").splitlines():
        if line.startswith("deps_revision="):
            return line.split("=", 1)[1].strip()
    return None


def write_marker(marker: Path) -> None:
    marker.write_text(f"ok\ndeps_revision={DEPS_REVISION}\n", encoding="utf-8")


def verify_install(vpy: Path, unirig_dir: Path, bpy_ok: bool, ext_dir: Path) -> None:
    script = ext_dir / "_verify_install.py"
    script.write_text(
        f"import sys\nsys.path.insert(0, {str(unirig_dir)!r})\n"
        "import yaml\nfrom box import Box\n"
        "import torch, torch_scatter, torch_cluster\n"
        "from flash_attn.modules.mha import MHA  # noqa: F401\n"
        "import spconv.pytorch  # noqa: F401\n"
        "import transformers, lightning, einops, omegaconf, trimesh, open3d, tqdm\n"
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

    vpy = venv_python(venv_dir)
    pip = [str(vpy), "-m", "pip"] if vpy.is_file() else None
    env = pip_env(ext_dir)

    if (
        marker.is_file()
        and vpy.is_file()
        and unirig_dir.is_dir()
        and read_marker_revision(marker) == DEPS_REVISION
    ):
        log("UniRig already installed, skipping.")
        return

    if marker.is_file() and vpy.is_file() and unirig_dir.is_dir() and pip:
        log("Updating UniRig Python dependencies…")
        apply_unirig_patches(unirig_dir)
        install_requirements_file(pip, MOSS3D_REQUIREMENTS, env)
        bpy_ok = try_install_bpy(pip, env)
        install_pyg_extensions(pip, env)
        install_spconv(pip, env)
        try_install_flash_attn(pip, env)
        verify_install(vpy, unirig_dir, bpy_ok, ext_dir)
        write_marker(marker)
        log("UniRig dependencies updated.")
        return

    if not unirig_dir.is_dir():
        log("Cloning UniRig repository…")
        run(["git", "clone", "--depth", "1", UNIRIG_REPO, str(unirig_dir)])

    apply_unirig_patches(unirig_dir)

    if not vpy.is_file():
        log("Creating UniRig virtual environment…")
        venv.EnvBuilder(with_pip=True).create(venv_dir)
        vpy = venv_python(venv_dir)

    pip = [str(vpy), "-m", "pip"]

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

    install_pyg_extensions(pip, env)
    install_spconv(pip, env)

    verify_install(vpy, unirig_dir, bpy_ok, ext_dir)

    write_marker(marker)
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
