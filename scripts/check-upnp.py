#!/usr/bin/env python3
import os
from pathlib import Path
import subprocess
import tempfile

script = Path(__file__).with_name("fockytv-upnp.sh").resolve()
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    stub = root / "upnpc"
    stub.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$UPNP_TEST_LOG"\nexit "${UPNP_TEST_FAILURE:-0}"\n')
    stub.chmod(0o755)
    log = root / "calls"
    env = dict(os.environ, PATH=f"{root}:{os.environ['PATH']}", UPNP_TEST_LOG=str(log))
    expected = [
        "-e FockyTV -a 192.168.1.129 7885 7885 UDP",
        "-e FockyTV -a 192.168.1.129 7892 7892 UDP",
        "-e FockyTV -a 192.168.1.129 7891 7891 TCP",
    ]
    for failure in ("0", "1", "124"):
        log.unlink(missing_ok=True)
        result = subprocess.run(["bash", str(script)], env=dict(env, UPNP_TEST_FAILURE=failure), capture_output=True, text=True)
        assert log.read_text().splitlines() == expected, "Must try all three authorized mappings, even after failure"
        assert result.returncode == (0 if failure == "0" else 1)
        if failure == "0":
            assert "atualizados" in result.stdout and not result.stderr
        else:
            assert result.stderr.count("falha ao encaminhar") == 3
            assert not result.stdout
print("UPnP: authorized ports, retries after errors, timeout failures and logs passed")
