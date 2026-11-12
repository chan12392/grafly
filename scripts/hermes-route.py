"""Legacy standalone Hermes hook, retained for provenance and excluded from npm.

Current installations use scripts/hermes-grafly, which owns grafly_route too.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess


def _trusted_which(name):
    for directory in os.get_exec_path():
        if not os.path.isabs(directory) or Path(directory).resolve() == Path.cwd().resolve():
            continue
        found = shutil.which(os.path.join(directory, name))
        if found:
            return found
    return None


def grafly_route(tool_name="", args=None, session_id="", **_kwargs):
    if tool_name != "terminal" or not isinstance(args, dict):
        return None
    from tools.terminal_tool import _get_env_config
    if _get_env_config().get("env_type") != "local":
        return None
    node = _trusted_which("node")
    if not node:
        return None
    if os.name == "nt":
        package = Path(os.environ.get("APPDATA", "")) / "npm/node_modules/grafly"
    else:
        cli = _trusted_which("grafly")
        if not cli:
            return None
        package = Path(cli).resolve().parent.parent
    hook = package / "dist/tool-output/route-hook.js"
    if not hook.is_file():
        return None
    from agent.runtime_cwd import resolve_agent_cwd
    try:
        result = subprocess.run(
            [node, str(hook), "hermes"],
            input=json.dumps({"tool_name": tool_name, "args": args, "shell": "bash", "session_id": session_id}),
            cwd=str(resolve_agent_cwd()), capture_output=True, text=True,
            encoding="utf-8", timeout=5,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        directive = json.loads(result.stdout) if result.returncode == 0 else {}
        return directive if directive.get("action") == "modify" else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
