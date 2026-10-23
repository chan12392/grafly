"""Own the updater child without creating a Windows console."""
import os
from pathlib import Path
import subprocess
import sys
import time

state = Path(os.environ.get("GRAFLY_MC_RUNTIME_HOME", Path.home() / ".grafly" / "mc-runtime"))
state.mkdir(parents=True, exist_ok=True)
with (state / "watcher.stdout.log").open("ab", buffering=0) as out, (state / "watcher.stderr.log").open("ab", buffering=0) as err:
    while True:
        try:
            child = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            code = child.wait()
        except OSError:
            err.write(b"mc_watcher_launch_failed\n")
            code = 1
        out.write(f"\nmc watcher exit={code}\n".encode())
        if code == 0:
            sys.exit(0)
        time.sleep(2)
