"""Hermes adapter for the same local hook used by Codex and Devin."""
import json
import os
from pathlib import Path
import shutil
import subprocess


def grafly_context(session_id="", user_message="", is_first_turn=False, **_kwargs):
    # Hermes desktop can serve several project sessions in one process. Never
    # infer their repository from the backend's process working directory.
    from agent.runtime_cwd import resolve_agent_cwd

    node = shutil.which("node")
    if not node:
        return None
    if os.name == "nt":
        package = Path(os.environ.get("APPDATA", "")) / "npm/node_modules/grafly"
    else:
        cli = shutil.which("grafly")
        if not cli:
            return None
        package = Path(cli).resolve().parent.parent
    shim = package / "scripts/grafly-devin-hook.cjs"
    if not shim.is_file():
        return None
    cwd = str(resolve_agent_cwd())
    payload = json.dumps({"cwd": cwd, "session_id": "hermes-" + session_id,
                          "prompt": user_message}, ensure_ascii=False)
    contexts = []
    for event in (["session-start", "prompt"] if is_first_turn else ["prompt"]):
        try:
            result = subprocess.run(
                [node, str(shim), event], input=payload, cwd=cwd,
                capture_output=True, text=True, encoding="utf-8", timeout=6,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            if result.returncode == 0 and result.stdout.strip():
                context = json.loads(result.stdout).get("hookSpecificOutput", {}).get("additionalContext")
                if isinstance(context, str) and context:
                    contexts.append(context)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            continue
    return {"context": "\n\n".join(contexts)} if contexts else None


def grafly_route(tool_name="", args=None, session_id="", **_kwargs):
    """Preserve host guards and only modify local terminal arguments."""
    if tool_name != "terminal" or not isinstance(args, dict):
        return None
    from tools.terminal_tool import _get_env_config
    if _get_env_config().get("env_type") != "local":
        return None
    node = shutil.which("node")
    if not node:
        return None
    if os.name == "nt":
        package = Path(os.environ.get("APPDATA", "")) / "npm/node_modules/grafly"
    else:
        cli = shutil.which("grafly")
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


def register(ctx):
    ctx.register_hook("pre_llm_call", grafly_context)
    ctx.register_hook("pre_tool_call", grafly_route)
