# Guests: people without Gestalt

A guest is someone who has no account and no Gestalt, and joins a voice chat or a direct chat with a Gestalt user by
opening a link in a web browser.

## What a user sees

Switch it on in **Settings, General, Guests** (it is off until you do).

- **Voice chat.** When you join a channel's voice room, Gestalt makes a link for it, shows it above the list of people
  (with a Copy button), and says in the channel, as an action, that you have entered voice chat and where to join from. The
  link works for up to four guests, for as long as you stay in the room. Leaving ends it, and sends the guests away.
  Joining as a listener makes no link, since a listener has no voice to pass the guests' on through.
- **Direct chat and calls.** When you ask someone for a direct chat or a call and nothing shows their client got the
  request within eight seconds, they are sent a one-time link by private message. So are people on a network that cannot
  carry the request at all. The link works for one person, once, for thirty minutes; they can reload the page and
  come back to it.
- **Guests in the room** are listed for you and for everyone else in the room, marked *guest*. A guest's name appears
  as "Sam (guest)" in your windows.

Switching guests off in Settings ends every open link at once, and a link can be ended from the same list.

## What a guest sees

The link opens the Gestalt page, which asks for a name, says plainly that their browser will connect straight to the
host's (so the host can see their network address), and connects when they press the button. A direct link opens the
same chat window a Gestalt user has: messages, files, and a call. A room link shows who is in the room, a mute button
and a Leave button.

## How it works

The bouncer stands in for the IRC network. The guest's page opens a WebSocket to `/api/guest/ws?token=…`; what it sends
reaches the host's browser as a signalling message from a made-up nick (`g-Sam`, whose host is always `guest.invalid`),
and the host's replies to that nick are handed back to the guest. After that the audio and the chat go browser to browser, over
WebRTC, as between two Gestalt users, and the safety codes work the same way.

In a voice room the guest has one connection, to the host. The host's browser mixes: the room hears the host's microphone
plus every guest, and each guest hears the host's microphone plus everyone else in the room, but not themselves. Nobody
else in the room connects to the guest, or learns their address. The people who are not the host see the guest because the host says
who they brought, with a `guests:` presence tag, in the same way people say they are in the room.

A client now answers a request for a direct chat or call with a one-line receipt as soon as it arrives. Nothing is connected and
nothing is shared until the user accepts; the receipt only tells the caller that someone is there to accept. A caller who gets none
takes the other person not to have Gestalt.

## Limits and safety

- Off for a user until they switch it on. The operator can turn it off for the whole bouncer with `disable_guests: true`.
- A link is 144 bits of randomness. Wrong guesses are counted per address and block it after ten in ten minutes.
- A room link takes four guests at once; a direct link takes one person, with a key to come back. At most four guests per
  address, and two hundred on the bouncer.
- A guest reaches only the person who made the link: no IRC, no account, no other user, no history. Only two kinds of
  message pass: signalling, and the room's roster. Names are cut to plain letters, digits and a few marks, 24 characters
  at most, and shown with "(guest)".
- Lines about guests that arrive from the IRC network are dropped by the bouncer, so nobody on a network can pose as one.
- A guest who sends too fast is disconnected. A host with no browser attached for twenty seconds loses their guests.
- Links are kept in the bouncer's memory only, so a restart ends them.
- The token is in the link's address, so a reverse proxy that logs requests will have it in its log. A link is worth little once its
  host has left, and a direct link is worth nothing once used.
- A guest is given the same STUN and TURN servers as a user, with credentials that last as long as `turn_ttl`.
