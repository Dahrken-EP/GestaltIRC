"""A small website for the media proxy to fetch from during the browser tests.

It serves a real PNG, a page with Open Graph tags, an HTML page that pretends to be
a picture, and the start of an MP4. The browser must never request any of these
itself: everything goes through the bouncer.
"""
import base64
import http.server
import os
import socketserver

# A 2x2 red PNG.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP4z8Dwn4GBgYGBgQEAFAAD/xIdL6AAAAAASUVORK5CYII="
)
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 200

PAGE = """<!doctype html><html><head>
<title>Plain title</title>
<meta property="og:title" content="An interesting article">
<meta property="og:description" content="Why the proxy exists, in two sentences.">
<meta property="og:site_name" content="Example Journal">
<meta property="og:image" content="/card.png">
</head><body><p>body</p></body></html>""".encode()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, ctype, body):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/pic.png", "/card.png"):
            self.reply("image/png", PNG)
        elif path == "/page.html":
            self.reply("text/html; charset=utf-8", PAGE)
        elif path == "/fake.png":
            self.reply("image/png", b"<html><script>alert(1)</script></html>")
        elif path == "/clip.mp4":
            self.reply("video/mp4", MP4)
        else:
            self.send_response(404)
            self.end_headers()


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    Server(("127.0.0.1", int(os.environ.get("SITE_PORT", "18081"))), Handler).serve_forever()
