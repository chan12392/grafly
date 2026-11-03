"""Run the scheduled search service without creating a Windows console."""
import subprocess
import sys
import time
from pathlib import Path

state = Path.home() / ".grafly" / "search-service"
state.mkdir(parents=True, exist_ok=True)
with (state / "stdout.log").open("ab", buffering=0) as out, (state / "stderr.log").open("ab", buffering=0) as err:
    while True:
        try:
            child = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL,
                                     stdout=out, stderr=err, creationflags=subprocess.CREATE_NO_WINDOW)
            code = child.wait()
        except OSError as error:
            err.write(f"search launch failed: {error}\n".encode())
            code = 1
        out.write(f"\nsearch service exit={code}\n".encode())
        if code == 0:
            sys.exit(0)
        # Scheduler RestartOnFailure did not restart a completed action whose
        # child failed on the actual host. Keep recovery with the child owner.
        time.sleep(2)
