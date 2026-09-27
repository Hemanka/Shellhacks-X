"""Launch the Windows dashboard and an optional HTTPS phone tunnel."""
import argparse
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--phone-url", help="Existing HTTPS address that forwards to this server")
    parser.add_argument("--no-tunnel", action="store_true")
    parser.add_argument("--tunnel", action="store_true", help="Start a temporary public Cloudflare HTTPS tunnel")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    load_dotenv(ROOT / ".env")
    load_dotenv(ROOT / ".env.local")
    runtime = ROOT / ".runtime"
    runtime.mkdir(exist_ok=True)
    stop_file = runtime / "stop"
    stop_file.unlink(missing_ok=True)
    local_url = f"http://127.0.0.1:{args.port}"
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", args.port)) == 0:
            raise SystemExit(f"Port {args.port} is already in use. Stop that server or choose another port.")
    processes = []
    handles = []
    environment = os.environ.copy()
    # Some local desktop sandboxes inject a dead loopback proxy. The Gemini
    # client already bypasses environment proxies; Hugging Face Hub reads them
    # directly, so strip only this known unusable endpoint for child processes.
    for proxy_name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        if environment.get(proxy_name, "").lower() in {
            "http://127.0.0.1:9", "https://127.0.0.1:9",
            "http://localhost:9", "https://localhost:9",
        }:
            environment.pop(proxy_name, None)
    cached_hf_home = runtime / "huggingface-no-symlinks"
    if not environment.get("HF_HOME") and cached_hf_home.exists():
        environment["HF_HOME"] = str(cached_hf_home)
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        # --tunnel means "create a fresh Quick Tunnel". Ignore an inherited
        # PAIR_BASE_URL in that mode: it may be a hostname from an older,
        # already-expired Quick Tunnel. Use --phone-url for an intentional
        # external/stable HTTPS address instead.
        if args.phone_url:
            public_url = args.phone_url
        elif args.tunnel and not args.no_tunnel:
            public_url = None
        else:
            public_url = environment.get("PAIR_BASE_URL")
        tunnel_path = ROOT / "cloudflared.exe"
        if not public_url and args.tunnel and not args.no_tunnel:
            if not tunnel_path.exists():
                raise SystemExit("cloudflared.exe is missing. Use --phone-url with your HTTPS address or --no-tunnel for local debugging.")
            log_path = runtime / "tunnel.log"
            tunnel_log = log_path.open("w", encoding="utf-8")
            handles.append(tunnel_log)
            tunnel = subprocess.Popen(
                [str(tunnel_path), "tunnel", "--protocol", "http2", "--url", local_url, "--no-autoupdate"],
                cwd=ROOT, stdout=tunnel_log, stderr=subprocess.STDOUT, creationflags=flags,
            )
            processes.append(tunnel)
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                tunnel_output = log_path.read_text(encoding="utf-8", errors="replace")
                match = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", tunnel_output)
                connected = "Registered tunnel connection" in tunnel_output
                if match and connected:
                    public_url = match.group(0)
                    break
                if tunnel.poll() is not None:
                    raise RuntimeError("Cloudflare Quick Tunnel exited before connecting. See .runtime/tunnel.log.")
                time.sleep(.25)
            if not public_url:
                raise RuntimeError("Cloudflare Quick Tunnel did not connect within 45 seconds. See .runtime/tunnel.log.")
        if public_url:
            environment["PAIR_BASE_URL"] = public_url
        server_log = (runtime / "server.log").open("w", encoding="utf-8")
        handles.append(server_log)
        server = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", str(args.port)],
            cwd=ROOT, env=environment, stdout=server_log, stderr=subprocess.STDOUT, creationflags=flags,
        )
        processes.append(server)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(f"{local_url}/api/health", timeout=1) as response:
                    if response.status == 200:
                        break
            except OSError:
                if server.poll() is not None:
                    raise RuntimeError("Server failed to start. See .runtime/server.log.")
                time.sleep(.25)
        else:
            raise RuntimeError("Server startup timed out. See .runtime/server.log.")
        print(f"Dashboard ready: {local_url}", flush=True)
        if public_url:
            print(f"Phone HTTPS base URL: {public_url}", flush=True)
            print("Cloudflare tunnel connected. Scan the QR code shown on this dashboard.", flush=True)
        if not args.no_browser:
            webbrowser.open(local_url)
        while server.poll() is None and not stop_file.exists():
            if len(processes) > 1 and processes[0].poll() is not None:
                raise RuntimeError("Cloudflare tunnel stopped; its QR link is no longer live. Restart the launcher for a fresh link. See .runtime/tunnel.log.")
            time.sleep(.5)
    except KeyboardInterrupt:
        pass
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                if os.name == "nt":
                    # Windows venv launchers may have a child Python process.
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                else:
                    process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
        for handle in handles:
            handle.close()
        stop_file.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
