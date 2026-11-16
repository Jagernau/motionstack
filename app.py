"""MotionStack: local-only HTTP server. Python standard library, no pip dependencies."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

if __name__ == "__main__":
    host, port = "127.0.0.1", 8787
    print(f"MotionStack: http://{host}:{port}  (Ctrl+C to stop)", flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
