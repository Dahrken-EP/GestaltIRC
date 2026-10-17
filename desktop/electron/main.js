// Gestalt on the desktop, for Linux, in Electron. Linux's own web view (WebKitGTK) has no WebRTC on Ubuntu and Debian,
// and Electron carries Chromium, which does. It does what the Tauri app does for Windows: a launcher that chooses
// between a bouncer run elsewhere and the one the app carries, then the bouncer's page, and nothing else.
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, session, shell } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const launcher = path.join(__dirname, '..', 'ui', 'index.html')
const settingsPath = path.join(app.getPath('userData'), 'settings.json')
let settings = { mode: '', url: '', port: 0, user: '', closeToTray: true }
try {
  settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) }
} catch {
  // first run
}
let win = null
let tray = null
let quitting = false
let child = null
/** The one address the window may show besides the launcher. */
let allowed = null

const save = () => {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

const resources = () => process.env.GESTALT_RESOURCES || (app.isPackaged ? path.join(process.resourcesPath, 'resources') : path.join(__dirname, '..', 'src-tauri', 'resources'))
const exe = () => path.join(resources(), process.platform === 'win32' ? 'bouncer.exe' : 'bouncer')
const dataDir = () => path.join(app.getPath('userData'), 'bouncer')

function stopLocal() {
  if (child) child.kill()
  child = null
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

const portFree = (port) =>
  port
    ? new Promise((resolve) => {
        const s = net.createServer()
        s.once('error', () => resolve(false))
        s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
      })
    : Promise.resolve(false)

function runBouncer(config, args, stdin) {
  const r = spawnSync(exe(), ['-config', config, ...args], { input: stdin === undefined ? '' : stdin + '\n', encoding: 'utf8' })
  if (r.error) throw new Error('could not start the bouncer: ' + r.error.message)
  if (r.status !== 0) throw new Error((r.stderr || '').trim().split('\n').pop() || 'the bouncer failed')
}

function waitFor(port) {
  const deadline = Date.now() + 20000
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const s = net.connect(port, '127.0.0.1')
      s.once('connect', () => (s.destroy(), resolve()))
      s.once('error', () => (Date.now() > deadline ? reject(new Error('The bouncer did not start.')) : setTimeout(attempt, 150)))
    }
    attempt()
  })
}

/** Starts the bouncer that comes with the app, making its files and the user's account the first time. */
async function startBouncer(user, password) {
  if (!fs.existsSync(exe())) throw new Error('This build of the app does not carry a bouncer.')
  const dir = dataDir()
  fs.mkdirSync(dir, { recursive: true })
  const config = path.join(dir, 'bouncer.yaml')
  const port = (await portFree(settings.port)) ? settings.port : await freePort()
  const q = (p) => p.replace(/'/g, "''")
  fs.writeFileSync(
    config,
    `listen: '127.0.0.1:${port}'\ndata_dir: '${q(dir)}'\nweb_dir: '${q(path.join(resources(), 'web'))}'\n# The bouncer runs on the user's own computer, so what it may reach is the user's business.\nallow_private_networks: true\n`,
  )
  if (!fs.existsSync(path.join(dir, 'bouncer.db'))) runBouncer(config, ['init'])
  if (user) {
    if (password.length < 8) throw new Error('Choose a password of at least 8 characters.')
    runBouncer(config, ['user', 'add', user], password)
  }
  stopLocal()
  child = spawn(exe(), ['-config', config, 'serve'], { stdio: 'ignore', windowsHide: true })
  await waitFor(port)
  settings.mode = 'local'
  settings.port = port
  if (user) settings.user = user
  save()
  return `http://127.0.0.1:${port}/`
}

function show(url) {
  allowed = new URL(url).origin
  return win.loadURL(url)
}

const fromLauncher = (e) => String(e.senderFrame?.url || '').startsWith('file://')
const handle = (name, fn) =>
  ipcMain.handle('gestalt:' + name, (e, args) => {
    if (!fromLauncher(e)) throw new Error('not allowed')
    return fn(args)
  })

handle('get_state', () => ({
  settings,
  local: fs.existsSync(exe()),
  local_ready: fs.existsSync(path.join(dataDir(), 'bouncer.db')),
}))
handle('connect_remote', async ({ url }) => {
  let u
  try {
    u = new URL(String(url).trim())
  } catch {
    throw new Error('That is not a web address. Try https://irc.example.org')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('The address must start with https:// (or http:// on a trusted network).')
  u.pathname = '/'
  u.search = ''
  u.hash = ''
  stopLocal()
  settings.mode = 'remote'
  settings.url = u.toString()
  save()
  await show(settings.url)
})
handle('start_local', async ({ user, password }) => {
  await show(await startBouncer(String(user || '').trim(), String(password || '')))
})
handle('report', ({ text }) => {
  // For checking a build without a person: GESTALT_DIAG=1 prints what the web view can do, then quits.
  if (process.env.GESTALT_DIAG) {
    console.log(text)
    app.exit(0)
  }
})

function backToLauncher() {
  allowed = null
  showWindow()
  void win.loadFile(launcher)
}

function showWindow() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function toggleWindow() {
  if (win?.isVisible() && win.isFocused()) win.hide()
  else showWindow()
}

/** The menu of the app and of the tray icon, the same, so the way out of a hidden window is always the tray. */
function menuTemplate() {
  return [
    { label: 'Show Gestalt', click: showWindow },
    { label: 'Change server…', click: backToLauncher },
    {
      label: 'Closing the window keeps Gestalt in the tray',
      type: 'checkbox',
      checked: settings.closeToTray,
      click: (item) => {
        settings.closeToTray = item.checked
        save()
        refreshMenus()
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]
}

function refreshMenus() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Gestalt', submenu: menuTemplate() }]))
  tray?.setContextMenu(Menu.buildFromTemplate(menuTemplate()))
}

// A second launch brings the first back, which also means a window hidden on a desktop with no tray is never lost.
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', showWindow)

app.whenReady().then(async () => {
  const mine = 'media'
  // The microphone and notifications, for the launcher and the bouncer the user chose, and nothing else.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    const origin = (() => {
      try {
        return new URL(wc.getURL()).origin
      } catch {
        return ''
      }
    })()
    cb((permission === mine || permission === 'notifications') && (origin === allowed || wc.getURL().startsWith('file://')))
  })

  // The page asks about permissions as well as for them: Notification.permission is a check, and with no answer it
  // says "default" until the user is asked, which is not how a desktop app should behave.
  session.defaultSession.setPermissionCheckHandler((wc, permission) => {
    const url = wc?.getURL() || ''
    const here = url.startsWith('file://') || (() => {
      try {
        return new URL(url).origin === allowed
      } catch {
        return false
      }
    })()
    return here && (permission === mine || permission === 'notifications')
  })
  ipcMain.on('gestalt:show', showWindow)

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 480,
    minHeight: 400,
    title: 'Gestalt',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  const wc = win.webContents
  // Only the launcher and the chosen bouncer. A link to anywhere else opens in the user's own browser.
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && new URL(url).origin !== allowed) e.preventDefault()
  })
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Closing the window hides it to the tray, where Gestalt stays connected, unless the user chose otherwise or is quitting.
  win.on('close', (e) => {
    if (!quitting && settings.closeToTray && tray) {
      e.preventDefault()
      win.hide()
    }
  })
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')))
    tray.setToolTip('Gestalt')
    tray.on('click', toggleWindow)
    app.tray = tray
  } catch {
    tray = null // no tray on this desktop: closing quits, as it would without one
  }
  refreshMenus()

  await win.loadFile(launcher)
  if (process.env.GESTALT_DIAG) return
  try {
    if (settings.mode === 'remote' && settings.url) await show(settings.url)
    else if (settings.mode === 'local') await show(await startBouncer('', ''))
  } catch {
    // stay on the launcher
  }
})

app.on('before-quit', () => {
  quitting = true
  stopLocal()
})
app.on('window-all-closed', () => app.quit())
