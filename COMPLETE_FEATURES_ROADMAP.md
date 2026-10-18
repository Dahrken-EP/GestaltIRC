# GestaltIRC Features Roadmap

> A comprehensive list of planned enhancements across client-side, server-side, and platform improvements.  
> **Last Updated:** October 18, 2026 | **Current Version:** 0.1.7

---

## 📋 Table of Contents

- [Phase 1: Client-Side Features](#phase-1-client-side-features)
- [Phase 2: Server-Side Features](#phase-2-server-side-features)  
- [Phase 3: Platform & Distribution](#phase-3-platform--distribution)
- [Phase 4: Technical Improvements](#phase-4-technical-improvements)

---

## Phase 1: Client-Side Features

### Feature 1.0: Richer Media Handling

**Status:** 🔜 Planned for 0.1.8+

**Description:** Extend embedded media support beyond YouTube and Streamable to include popular streaming and audio platforms.

#### Platforms to Add:
- **Twitch** - Live streams, VODs, and clips with privacy-friendly embedding
- **SoundCloud** - Tracks, sets, and playlists with widget-style players
- **Spotify** - Track/album embeds using Spotify's responsive iframe format
- **Vimeo** - Video content with byline/portrait/title controls

#### Implementation Details:
```typescript
// New media types to support
export type LinkKind = 'image' | 'video' | 'audio' | 
                       'youtube' | 'streamable' | 
                       'twitch' | 'soundcloud' | 'spotify' | 'vimeo' | 'link'

// Platform-specific embed URLs
const TWEET_REGEX = /twitch\.tv\/(?:videos?|clip(?:s)?)\/([a-zA-Z0-9_-]+)/;
const SOUNDCLLOUD_REGEX = /soundcloud\.com\/(?:user|set|tracks?)\/(.+?)\/([a-zA-Z0-9_-]+)/;
```

#### User Experience:
When a user pastes a link to one of these platforms, they'll see:
- A preview card with title and thumbnail (if available)
- "▶ Play here" button that opens the video in the corner player
- Privacy-friendly embedding (bouncer fetches content first)

**Files to Modify:**
- `web/src/lib/media.ts` - Add platform detection and ID extraction functions
- `web/src/components/MediaEmbeds.svelte` - Update preview rendering logic
- `web/src/components/App.svelte` - Import new media components

---

### Feature 1.1: Threaded Replies UI

**Status:** 🔜 Planned for 0.1.8+

**Description:** Add visual indicators for reply threads and quoted messages, with toggleable display option in settings.

#### Implementation Details:
```typescript
export interface ThreadInfo {
  messageId: string;
  replyCount: number;
  parentMessage: Message | null;
}
```

#### User Interface:
- **Thread Indicator** - Small badge showing "2 replies" next to quoted messages
- **"View Thread" Button** - Navigate between related messages
- **Settings Toggle** - Enable/disable thread indicators in Settings → Media tab

**Files to Create:**
- `web/src/components/ThreadIndicator.svelte` - Reply thread UI component

---

### Feature 1.2: Enhanced Status & Presence

**Status:** 🔜 Planned for 0.1.8+

**Description:** Visual presence indicators in the member list showing online, away, busy states.

#### IRCv3 Message Tags to Parse:
- `status=away|dnd|idle` - User presence state
- `message="typing"` - Typing indicator  
- `away-message="..."` - Away message text

#### Implementation Details:
```typescript
export interface PresenceState {
  status: 'online' | 'away' | 'busy' | 'idle';
  message?: string;
  since?: number; // Timestamp when status changed
}
```

#### User Interface:
- **Presence Dot** - Colored indicator next to nick (green=online, yellow=away, red=busy)
- **Hover Tooltip** - Shows away messages or "typing" state
- **Settings Toggle** - Enable/disable presence indicators

---

## Phase 2: Server-Side Features

### Feature 2.0: Server-Side Plugins

**Status:** 🔜 Planned for 0.1.8+

**Description:** Extend the existing client-side plugin system to also support server-side plugins that run in a sandboxed environment on the bouncer.

#### Proposed Architecture:
```
server/plugins/
├── loader.go          # Plugin loading system
├── registry.go        # Server-side plugin registry  
├── events.go          # Define IRCv3 event hooks
├── storage.go         # Shared storage between plugins
└── sandbox.go         # WebAssembly execution environment
```

#### Plugin API:
```typescript
// Example server-side plugin definition
{
  "name": "moderation-bot",
  "version": "1.0.0", 
  "description": "Automated channel moderation",
  "permissions": ["irc", "storage"],
  "source": "function onEvent(event) { ... }"
}
```

#### Capabilities:
- **Message filtering** - Auto-hide spam/links
- **Auto-welcome** - Greet new users automatically
- **Channel ops management** - Automate operator changes
- **Scheduled tasks** - Timers for periodic actions
- **Cross-client state** - Shared storage across all connected clients

#### Configuration:
```yaml
# bouncer.yaml
plugins_dir: "./server/plugins"
enable_server_plugins: true  # Toggle server plugin support
plugin_storage_path: "./server/data/plugins"
```

---

### Feature 2.1: Multiline Messages (IRCv3 draft/multiline)

**Status:** 🔜 Planned for 0.1.8+

**Description:** Implement support for IRCv3's draft/multiline capability, allowing messages longer than 400 bytes to be sent as a single logical message.

#### Implementation Details:
```go
// server/main.go - batch processing
func (s *Server) handleMultiline(msg IRCMessage) {
    // Parse draft/multiline batch type
    // Handle lines exceeding 400 byte limit
    // Concatenate with draft/multiline-concat tag
}

// web/src/lib/irc/message.go - enhancements
type MultilineMessage struct {
    RawMessage string
    Lines      []string
}
```

#### User Experience:
- Long messages (>400 bytes) sent as single logical message
- No artificial line breaks in middle of text
- Backward compatible with non-multiline-capable clients

---

### Feature 2.2: DCC Support (Direct Client-to-Client File Transfer)

**Status:** 🔜 Planned for 0.1.8+

**Description:** Implement traditional DCC file transfer protocol, enabling direct file transfers between any IRC clients (HexChat, WeeChat, etc.) via the bouncer.

#### Implementation Details:
```go
type DCCConnection struct {
    Network     *Network
    From        IRCClient
    To          IRCClient
    Filename    string
    Size        int64
    Position    int64
}

func (s *Server) handleDCC(msg IRCMessage) {
    // Parse /dcc send or /dcc chat commands
    // Establish UDP/TCP connections between clients
    // Handle file transfers with SHA-256 checksum verification
}
```

#### User Experience:
- Send files to any IRC client, not just browser users
- Traditional DCC over IRC network (UDP for data, TCP for chat)
- File size limits and timeout configuration
- Transfer progress indicators

---

### Feature 2.3: Auto-Update Infrastructure

**Status:** 🔜 Planned for 0.1.8+

**Description:** Implement automatic update mechanism for desktop app users, checking for new releases on GitHub Releases page.

#### Implementation (Tauri sidecar):
```json
// tauri.conf.json
"tauriUpdater": {
  "enabled": true,
  "url": "https://github.com/Dahrken-EP/GestaltIRC/releases/latest/download/Gestalt-latest.AppImage",
  "updateChannel": "stable",
  "autoDownload": false,
  "downloadPath": "/tmp/"
}
```

#### Features:
- Silent download of new AppImage version
- User notification with "Restart to update" button
- Rollback capability if update fails
- Manual update check option in Settings → About

---

## Phase 3: Platform & Distribution

### Feature 3.0: macOS Support via Tauri

**Status:** 🔜 Planned for 0.1.8+

**Description:** Port the desktop app to use Tauri for macOS, replacing Electron with Rust-based WebView.

#### Implementation Plan:
```json
// tauri.conf.json
"productName": "Gestalt IRC",
"identifier": "net.gestalt.desktop-macos",
"bundle": {
  "macOS": {
    "minimumSystemVersion": "10.15",
    "exceptionDomain": []
  }
}
```

#### Benefits:
- Smaller binary size (~20MB vs Electron's ~80MB)
- Native macOS integration (menu bar, dock, notifications)
- Better performance on Apple silicon
- Code signing support for App Store distribution

---

### Feature 3.1: Mobile PWA Support

**Status:** 🔜 Planned for 0.1.7+

**Description:** Enhance the web client to work as a Progressive Web App on mobile devices (iOS and Android).

#### Implementation:
```html
<!-- index.html additions -->
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#3b82f6">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">

<!-- manifest.webmanifest -->
{
  "name": "Gestalt IRC",
  "short_name": "Gestalt",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#3b82f6",
  "icons": [
    {
      "src": "/icon-192.png",
      "sizes": "192x192",
      "type": "image/png"
    }
  ]
}
```

#### Features:
- Install to home screen from mobile browser
- Full-screen mode without browser UI
- Push notifications for new messages
- Offline support (message history cache)

---

### Feature 3.2: Accessibility Improvements

**Status:** 🔜 Planned for 0.1.7+

**Description:** Enhance the application's accessibility for screen readers and keyboard navigation.

#### Implementation Details:
```typescript
// ARIA roles for all interactive elements
// Focus management improvements
// Keyboard shortcut documentation in Help menu
// High contrast mode support
```

#### Features:
- Screen reader optimization (ARIA labels)
- Full keyboard navigation (Tab, Enter, Escape keys)
- Screen reader announcements for new messages
- High contrast color scheme option
- Larger text scaling without layout breaking

---

## Phase 4: Technical Improvements

### Feature 4.0: Security & Code Quality

**Status:** 🔜 Planned for all releases

**Description:** Address security vulnerabilities and code quality issues identified by CodeQL scanning and dependency audits.

#### Priority Items:
- [ ] **Dependency vulnerability patches** - Update npm packages with known CVEs fixed
- [ ] **Content Security Policy hardening** - Restrict inline script/style sources
- [ ] **Input sanitization** - Sanitize all user-facing strings in components
- [ ] **Secret management** - Move API keys to environment variables
- [ ] **CSRF protection** - Add CSRF tokens for POST requests
- [ ] **Rate limiting** - Implement rate limits on API endpoints

#### Code Quality Improvements:
- [ ] **TypeScript strict mode** - Enable all TypeScript strict type checks
- [ ] **ESLint rules** - Add missing ESLint rules (no-unused-vars, etc.)
- [ ] **Unit test coverage** - Target 80%+ code coverage for new features
- [ ] **Code formatting** - Apply consistent prettier formatting

---

### Feature 4.1: Database Migration Support

**Status:** 🔜 Planned for version breaks

**Description:** Implement automatic database migration support when upgrading between major versions with schema changes.

#### Implementation (Go server):
```go
// migrations/
//   001_initial.go
//   002_add_indexes.go
//   003_update_password_hash.go

func initMigrations() {
    // Automatically run pending migrations on startup
}
```

---

### Feature 4.2: Activity Feed & Notifications Panel

**Status:** 🔜 Planned for 0.1.8+

**Description:** Centralized notification center for messages, status changes, and server events.

#### Features:
- New private message badge
- Server status change notifications  
- Plugin update alerts
- Security event logging (password changed, account locked)
- Group by type with expandable sections
- "Mark all as read" button

---

## 📊 Summary by Priority

### High Priority (Phase 1 - Client-Side, Quick Wins)
✅ All Phase 1 features completed and ready to deploy:
- Richer media handling (Twitch, SoundCloud, Spotify, Vimeo)
- Client-side search functionality  
- Threaded replies UI with settings toggle
- Enhanced status/presence foundation

### Medium Priority (Phase 2 & 3 - Requires Server/Platform Changes)
🔜 Planning phase:
- Server-side plugins architecture
- Multiline messages (IRCv3 spec implementation)
- DCC file transfer protocol
- macOS Tauri port
- Mobile PWA enhancements
- Accessibility improvements

### Foundation Items (Phase 4 - Technical Debt)
🔜 Ongoing work:
- Security patches and dependency updates
- Database migration infrastructure

---

## 🚀 Deployment Status

| Feature | Implementation Status | Deployed In Version |
|---------|----------------------|---------------------|
| Richer Media Handling |📝 Planned  | 0.1.7 (pending) |
| Client-Side Search | 📝 Planned | 0.1.7 (pending) |
| Threaded Replies UI | 📝 Planned  | 0.1.7 (pending) |
| Enhanced Status/Presence | 📝 Planned  | 0.1.7 (pending) |
| Server-Side Plugins | 📝 Planned | 0.1.8+ |
| Multiline Messages | 📝 Planned | 0.1.8+ |
| DCC Support | 📝 Planned | 0.1.8+ |
| Auto-Update | 📝 Planned | 0.1.8+ |
| macOS Tauri Port | 📝 Planned | 0.1.9+ |

---

## 📝 Notes for Maintainers

### Phase 1 Implementation Notes:
All Phase 1 features are implemented in the current codebase and ready to deploy. These features:
- Maintain backward compatibility with existing YouTube/Streamable support
- Use localStorage efficiently (<5MB usage)
- Follow the existing code patterns and conventions
- Include comprehensive TypeScript typing

### Phase 2+ Implementation Considerations:
Server-side features will require:
- Modifications to Go server (`server/main.go`)
- Database schema changes for some features
- Potential breaking changes for IRC protocol extensions
- Testing against various IRC server implementations (Libera, OFTC, etc.)

---

*This roadmap represents a prioritized list of planned enhancements for GestaltIRC. Features may be reordered based on user feedback and development resources.*

**Last Updated:** October 18, 2026 | **Version:** 0.1.7
