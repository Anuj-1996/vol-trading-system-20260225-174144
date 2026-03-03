"""Thin wrapper to import the C++ vol_core extension.

If the compiled .so is not found, all functions fall back to None
so callers can check `if vol_core is not None:` before using.
"""
import sys
import os

_cpp_dir = os.path.dirname(os.path.abspath(__file__))

# Add the cpp directory to sys.path so `import vol_core` works
if _cpp_dir not in sys.path:
    sys.path.insert(0, _cpp_dir)

try:
    import vol_core  # noqa: F401  — the compiled C++ module
    HAS_CPP = True
except ImportError:
    vol_core = None  # type: ignore
    HAS_CPP = False
