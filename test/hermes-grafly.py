"""Adapter contract tests; run with the installed Hermes Python interpreter."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

adapter_path = Path(__file__).resolve().parents[1] / "scripts/hermes-grafly/__init__.py"
spec = importlib.util.spec_from_file_location("grafly_adapter_test", adapter_path)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.cwd = str(Path.cwd())
        runtime = types.ModuleType("agent.runtime_cwd")
        runtime.resolve_agent_cwd = lambda: Path(self.cwd)
        self.modules = patch.dict(sys.modules, {"agent.runtime_cwd": runtime})
        self.modules.start()
        self.addCleanup(self.modules.stop)

    def invoke(self, result, first=True):
        with patch.object(adapter.shutil, "which", return_value=sys.executable), \
             patch.object(Path, "is_file", return_value=True), \
             patch.object(adapter.subprocess, "run", side_effect=result) as run:
            context = adapter.grafly_context(session_id="test", user_message="classify 함수", is_first_turn=first)
            return context, run.call_args_list

    def test_session_project_and_first_turn_context(self):
        def response(args, **kwargs):
            payload = json.loads(kwargs["input"])
            self.assertEqual(payload["cwd"], self.cwd)
            self.assertEqual(payload["session_id"], "hermes-test")
            self.assertEqual(payload["prompt"], "classify 함수")
            self.assertEqual(kwargs["cwd"], self.cwd)
            self.assertTrue(kwargs["capture_output"])
            return subprocess.CompletedProcess(args, 0, json.dumps({"hookSpecificOutput": {"additionalContext": args[-1]}}), "")
        context, calls = self.invoke(response)
        self.assertEqual(context, {"context": "session-start\n\nprompt"})
        self.assertEqual(len(calls), 2)
        self.cwd = str(Path.cwd().parent)
        context, calls = self.invoke(response, first=False)
        self.assertEqual(context, {"context": "prompt"})
        self.assertEqual(len(calls), 1)

    def test_failures_leave_hermes_turn_available(self):
        for failure in [subprocess.TimeoutExpired("node", 6), OSError("missing")]:
            context, _ = self.invoke(failure)
            self.assertIsNone(context)
        context, _ = self.invoke(lambda *a, **kw: subprocess.CompletedProcess(a, 0, "not JSON", ""))
        self.assertIsNone(context)

    def test_registers_context_and_argument_routing(self):
        registered = []
        adapter.register(types.SimpleNamespace(register_hook=lambda name, fn: registered.append((name, fn))))
        self.assertEqual(registered, [("pre_llm_call", adapter.grafly_context),
                                      ("pre_tool_call", adapter.grafly_route)])

    def test_routing_preserves_local_cwd_and_host_arguments(self):
        terminal = types.ModuleType("tools.terminal_tool")
        terminal._get_env_config = lambda: {"env_type": "local"}
        args = {"command": "rg needle .", "workdir": self.cwd, "timeout": 17}
        modified = {**args, "command": "wrapped command"}
        def response(command, **kwargs):
            self.assertEqual(command[-1], "hermes")
            self.assertEqual(kwargs["cwd"], self.cwd)
            self.assertEqual(json.loads(kwargs["input"]),
                             {"tool_name": "terminal", "args": args, "shell": "bash", "session_id": "host-session"})
            return subprocess.CompletedProcess(command, 0, json.dumps({"action": "modify", "args": modified}), "")
        with patch.dict(sys.modules, {"tools.terminal_tool": terminal}), \
             patch.object(adapter.shutil, "which", return_value=sys.executable), \
             patch.object(Path, "is_file", return_value=True), \
             patch.object(adapter.subprocess, "run", side_effect=response):
            self.assertEqual(adapter.grafly_route("terminal", args, session_id="host-session"), {"action": "modify", "args": modified})
        self.assertEqual(args["command"], "rg needle .")

    def test_remote_and_native_tools_do_not_spawn_local_wrapper(self):
        terminal = types.ModuleType("tools.terminal_tool")
        terminal._get_env_config = lambda: {"env_type": "docker"}
        with patch.dict(sys.modules, {"tools.terminal_tool": terminal}), \
             patch.object(adapter.subprocess, "run") as run:
            self.assertIsNone(adapter.grafly_route("terminal", {"command": "rg needle ."}))
            self.assertIsNone(adapter.grafly_route("read_file", {"path": "README.md"}))
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
