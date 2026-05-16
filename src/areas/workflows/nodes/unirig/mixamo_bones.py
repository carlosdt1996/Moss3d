"""
Mixamo-style bone names (body + hand groups) for UniRig skeleton outputs.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import yaml

MIXAMO_PARTS_ORDER = ("body", "hand")
MIXAMO_PREFIX = "mixamorig:"


def normalize_bone_name(name: str) -> str:
    n = str(name)
    if n.startswith(MIXAMO_PREFIX):
        return n[len(MIXAMO_PREFIX) :]
    return n


def load_mixamo_template(unirig_root: Path) -> list[str]:
    mixamo_yaml = unirig_root / "configs" / "skeleton" / "mixamo.yaml"
    if not mixamo_yaml.is_file():
        raise FileNotFoundError(f"Mixamo skeleton config not found: {mixamo_yaml}")
    data = yaml.safe_load(mixamo_yaml.read_text(encoding="utf-8"))
    parts = data["parts"]
    names: list[str] = []
    for part in data.get("parts_order", MIXAMO_PARTS_ORDER):
        names.extend(normalize_bone_name(n) for n in parts[part])
    return names


def looks_like_generic_names(names: list[str]) -> bool:
    if not names:
        return True
    generic = sum(1 for n in names if n.startswith("bone_") or n == "Root")
    return generic >= max(1, len(names) // 2)


def mixamo_names_for_bone_count(template: list[str], num_bones: int) -> list[str]:
    if num_bones <= len(template):
        return template[:num_bones]
    extra = [f"bone_{i}" for i in range(len(template), num_bones)]
    return template + extra


def apply_mixamo_names_to_npz(npz_path: Path, unirig_root: Path) -> bool:
    """Rewrite skeleton npz names to Mixamo-style groups (no mixamorig: prefix). Returns True if updated."""
    if not npz_path.is_file():
        return False

    archive = np.load(npz_path, allow_pickle=True)
    data = {key: archive[key][()] for key in archive.files}
    archive.close()

    names_raw = data.get("names")
    if names_raw is None:
        joints = data.get("joints")
        if joints is None:
            return False
        num_bones = int(np.asarray(joints).shape[0])
        current: list[str] = []
    else:
        current = [str(n) for n in list(names_raw)]
        num_bones = len(current)

    if current and not looks_like_generic_names(current):
        if not any(str(n).startswith(MIXAMO_PREFIX) for n in current):
            return False
        data["names"] = np.array([normalize_bone_name(n) for n in current], dtype=object)
        np.savez(npz_path, **data)
        return True

    template = load_mixamo_template(unirig_root)
    data["names"] = np.array(mixamo_names_for_bone_count(template, num_bones), dtype=object)
    data["cls"] = "mixamo"
    np.savez(npz_path, **data)
    return True


def apply_mixamo_names_under_npz_dir(npz_dir: Path, unirig_root: Path) -> int:
    updated = 0
    for npz_path in npz_dir.rglob("predict_skeleton.npz"):
        if apply_mixamo_names_to_npz(npz_path, unirig_root):
            updated += 1
    return updated
