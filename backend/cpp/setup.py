"""Build script for the vol_core C++ extension.

Usage:
    cd 'Vol Trading' && .venv/bin/python backend/cpp/setup.py build_ext --inplace
    # → produces vol_core.cpython-*.so in backend/cpp/
"""

import os
import sys
import platform
from pathlib import Path

import pybind11
from setuptools import setup, Extension

cpp_dir = Path(__file__).resolve().parent

extra_compile_args = ["-O3", "-std=c++17", "-ffast-math", "-Wall"]

# Apple Silicon: enable NEON + tune for latest ARM
if platform.machine() == "arm64":
    extra_compile_args += [
        "-mcpu=apple-m4",       # M4-specific tuning (falls back gracefully)
        "-DACCELERATE_NEW_LAPACK",
    ]
else:
    extra_compile_args += ["-march=native"]

# Suppress pybind11 warnings
extra_compile_args += ["-Wno-unused-variable", "-Wno-sign-compare"]

ext = Extension(
    "vol_core",
    sources=[str(cpp_dir / "vol_core.cpp")],
    include_dirs=[pybind11.get_include()],
    language="c++",
    extra_compile_args=extra_compile_args,
    extra_link_args=["-O3"],
)

setup(
    name="vol_core",
    version="1.0.0",
    description="High-performance C++ core for Heston engine",
    ext_modules=[ext],
    zip_safe=False,
)
