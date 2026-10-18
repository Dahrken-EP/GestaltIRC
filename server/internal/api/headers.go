package api

import (
	"net/http"
	"strconv"
)

// AppCSP is the content security policy of the web client. The same policy, without the two
// directives a <meta> tag cannot carry, is in web/index.html, and a test keeps them in step.
const AppCSP = "default-src 'self'; connect-src 'self' ws: wss: https://api.soundcloud.com; img-src 'self' data: https://i.imgur.com; media-src 'self' https://i.imgur.com; " +
	"frame-src 'self' https://www.youtube-nocookie.com https://streamable.com https://player.twitch.tv https://clips.twitch.tv https://w.soundcloud.com https://open.spotify.com https://player.vimeo.com; style-src 'self' 'unsafe-inline'; " +
	"object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"

// sandboxPage is the page that hosts plugin workers. It is framed by the client, from the same
// address, and carries its own policy in a <meta> tag.
const sandboxPage = "/plugin-sandbox.html"

// WithSecurityHeaders adds the headers every response should carry. Handlers that need something
// stricter, such as the media proxy, set their own afterwards and win.
func (a *API) WithSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		// The microphone is for voice, and only for this page. Nothing here uses the rest.
		h.Set("Permissions-Policy", "microphone=(self), camera=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()")
		if r.URL.Path == sandboxPage {
			// The one page that may be framed, by this site only. Its own policy is in the page.
			h.Set("X-Frame-Options", "SAMEORIGIN")
			h.Set("Content-Security-Policy", "frame-ancestors 'self'")
		} else {
			h.Set("X-Frame-Options", "DENY")
			h.Set("Content-Security-Policy", AppCSP)
		}
		// Once the operator has said HTTPS works (sts_duration), browsers are told to insist on it.
		if a.Conf.STSDuration > 0 && a.IsSecure(r) {
			h.Set("Strict-Transport-Security", "max-age="+strconv.Itoa(a.Conf.STSDuration))
		}
		next.ServeHTTP(w, r)
	})
}
