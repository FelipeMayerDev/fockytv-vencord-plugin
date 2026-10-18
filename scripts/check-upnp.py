#!/usr/bin/env python3
import os
from pathlib import Path
import subprocess
import tempfile

script = Path(__file__).with_name("fockytv-upnp.sh").resolve()
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    stub = root / "upnpc"
    stub.write_text(
        '#!/bin/sh\n'
        'if [ "$1" = -s ]; then echo "ExternalIPAddress = $UPNP_TEST_IP"; exit 0; fi\n'
        'printf "%s\\n" "$*" >> "$UPNP_TEST_LOG"\nexit "${UPNP_TEST_FAILURE:-0}"\n'
    )
    stub.chmod(0o755)
    docker = root / "docker"
    docker.write_text('#!/bin/sh\nprintf "%s|%s\\n" "$PWD" "$*" >> "$DOCKER_TEST_LOG"\n')
    docker.chmod(0o755)
    server = root / "server"
    server.mkdir()
    env_file = server / ".env"
    log = root / "calls"
    docker_log = root / "docker-calls"
    env = dict(os.environ, PATH=f"{root}:{os.environ['PATH']}", UPNP_TEST_LOG=str(log),
               DOCKER_TEST_LOG=str(docker_log), FOCKYTV_SERVER_DIR=str(server), UPNP_TEST_IP="1.2.3.4")
    expected = [
        "-e FockyTV -a 192.168.1.129 7885 7885 UDP",
        "-e FockyTV -a 192.168.1.129 7892 7892 UDP",
        "-e FockyTV -a 192.168.1.129 7891 7891 TCP",
    ]
    for failure in ("0", "1", "124"):
        env_file.write_text("LIVEKIT_API_KEY=k\nLIVEKIT_NODE_IP=1.2.3.4\n")
        log.unlink(missing_ok=True)
        result = subprocess.run(["bash", str(script)], env=dict(env, UPNP_TEST_FAILURE=failure), capture_output=True, text=True)
        assert log.read_text().splitlines() == expected, "Must try all three authorized mappings, even after failure"
        assert result.returncode == (0 if failure == "0" else 1)
        if failure == "0":
            assert "atualizados" in result.stdout and not result.stderr
        else:
            assert result.stderr.count("falha ao encaminhar") == 3
            assert not result.stdout
    assert not docker_log.exists(), "Unchanged IP must not recreate LiveKit"

    for bad_ip in ("", "0.0.0.0", "garbage"):
        subprocess.run(["bash", str(script)], env=dict(env, UPNP_TEST_IP=bad_ip), capture_output=True, text=True)
        assert "LIVEKIT_NODE_IP=1.2.3.4" in env_file.read_text()
    assert not docker_log.exists(), "Invalid router IP must be ignored"

    result = subprocess.run(["bash", str(script)], env=dict(env, UPNP_TEST_IP="5.6.7.8"), capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert env_file.read_text() == "LIVEKIT_API_KEY=k\nLIVEKIT_NODE_IP=5.6.7.8\n"
    assert docker_log.read_text() == f"{server}|compose -f docker-compose.yml -f docker-compose.livekit.yml up -d livekit livekit-ingress\n"
    assert "1.2.3.4 para 5.6.7.8" in result.stdout
print("UPnP: authorized ports, retries, timeouts, logs and public IP refresh passed")
