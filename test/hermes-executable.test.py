"""Exercise both shipped and legacy adapters against a cwd/PATH executable trap."""
import importlib.util
import os
from pathlib import Path
import tempfile

root = Path(__file__).resolve().parent.parent
for script in ("scripts/hermes-grafly/__init__.py", "scripts/hermes-route.py"):
    spec = importlib.util.spec_from_file_location("grafly_adapter", root / script)
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)
    with tempfile.TemporaryDirectory(prefix="grafly-executable-") as directory:
        previous_cwd, previous_path = os.getcwd(), os.environ["PATH"]
        try:
            os.chdir(directory)
            Path("node.exe").write_text("untrusted fixture", encoding="utf8")
            Path("node").write_text("untrusted fixture", encoding="utf8")
            os.environ["PATH"] = os.pathsep.join((directory, ".", previous_path))
            found = adapter._trusted_which("node")
            assert found and Path(found).resolve().parent != Path(directory), script
        finally:
            os.chdir(previous_cwd)
            os.environ["PATH"] = previous_path
print("Python executable lookup boundaries: passed")
