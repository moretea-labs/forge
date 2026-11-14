#!/usr/bin/env python3
"""Existing macOS Tunnel LaunchAgent entrypoint: follow the active system proxy.

The LaunchAgent remains the only service owner. This launcher supervises exactly
one tunnel-client child and refreshes it only when scutil's effective proxy
configuration changes; it neither changes system network settings nor persists
an independent proxy authority.
"""
from __future__ import annotations

import os
import re
import signal
import subprocess
import sys
from typing import Mapping


PROXY_KEYS = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")
LOCAL_BYPASS = ("localhost", "127.0.0.1", "::1")


def proxy_environment(snapshot: str, inherited: Mapping[str, str]) -> dict[str, str]:
    values = dict(re.findall(r"^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*?)\s*$", snapshot, re.M))
    if not values:
        raise ValueError("MACOS_SYSTEM_PROXY_INVALID")

    def endpoint(kind: str, scheme: str) -> str | None:
        if values.get(kind + "Enable") != "1":
            return None
        host = values.get(kind + "Proxy", "").strip()
        raw_port = values.get(kind + "Port", "")
        if not re.fullmatch(r"[A-Za-z0-9.\-:\[\]]+", host) or not raw_port.isdigit():
            raise ValueError("MACOS_SYSTEM_PROXY_INVALID")
        port = int(raw_port)
        if not 1 <= port <= 65535:
            raise ValueError("MACOS_SYSTEM_PROXY_INVALID")
        if ":" in host and not host.startswith("["):
            host = "[" + host + "]"
        return f"{scheme}://{host}:{port}"

    https = endpoint("HTTPS", "http")
    http = endpoint("HTTP", "http")
    socks = endpoint("SOCKS", "socks5")
    if not (https or http or socks) and values.get("ProxyAutoConfigEnable") == "1":
        raise ValueError("MACOS_SYSTEM_PROXY_PAC_UNSUPPORTED")

    env = dict(inherited)
    for key in PROXY_KEYS:
        env.pop(key, None)
    if selected := (http or https or socks):
        env["HTTP_PROXY"] = env["http_proxy"] = selected
    if selected := (https or http or socks):
        env["HTTPS_PROXY"] = env["https_proxy"] = selected
    exceptions = []
    for item in (inherited.get("NO_PROXY", ""), inherited.get("no_proxy", ""), *LOCAL_BYPASS):
        for value in item.split(","):
            if value.strip() and value.strip() not in exceptions:
                exceptions.append(value.strip())
    env["NO_PROXY"] = env["no_proxy"] = ",".join(exceptions)
    return env


def current_environment(inherited: Mapping[str, str]) -> dict[str, str]:
    snapshot = subprocess.run(
        ["/usr/sbin/scutil", "--proxy"], text=True, capture_output=True,
        timeout=3, check=True,
    ).stdout
    return proxy_environment(snapshot, inherited)


def proxy_identity(env: Mapping[str, str]) -> tuple[str, str, str]:
    return (env.get("HTTP_PROXY", ""), env.get("HTTPS_PROXY", ""), env.get("NO_PROXY", ""))


def stop_child(child: subprocess.Popen[bytes]) -> None:
    if child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()


def run(argv: list[str], interval: int = 15) -> int:
    if not argv:
        raise ValueError("TUNNEL_COMMAND_REQUIRED")
    original = os.environ.copy()
    shutting_down = False
    child: subprocess.Popen[bytes] | None = None

    def shutdown(_signal: int, _frame: object) -> None:
        nonlocal shutting_down
        shutting_down = True
        if child is not None and child.poll() is None:
            child.terminate()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        environment = current_environment(original)
        while not shutting_down:
            child = subprocess.Popen(argv, env=environment)
            try:
                while not shutting_down:
                    try:
                        code = child.wait(timeout=interval)
                        return code if code >= 0 else 128 - code
                    except subprocess.TimeoutExpired:
                        pass
                    try:
                        updated = current_environment(original)
                    except (OSError, ValueError, subprocess.SubprocessError):
                        # Keep the known running connection on a transient
                        # network-settings read failure; do not select a guess.
                        continue
                    if proxy_identity(updated) == proxy_identity(environment):
                        continue
                    stop_child(child)
                    environment = updated
                    break
            finally:
                stop_child(child)
        return 0
    finally:
        if child is not None:
            stop_child(child)


if __name__ == "__main__":
    try:
        sys.exit(run(sys.argv[1:]))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"mac-tunnel-follow-system-proxy: {error}", file=sys.stderr)
        sys.exit(1)
