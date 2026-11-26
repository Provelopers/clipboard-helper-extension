# Clipboard Helper (GNOME Shell extension)

The companion extension for the Clipboard app, a clipboard history manager by
Provelopers. Its identifier is `clipboard-helper@provelopers.net`.

On its own this extension does nothing: it only works together with the
Clipboard app, and shows the app's icon in the top bar only while the app is
running.

## Why the app needs it

GNOME on Wayland on purpose keeps ordinary apps from reading the clipboard
while another app is in front, holding a shortcut for the whole desktop,
bringing their own windows to the front, and typing into other apps. A
clipboard manager needs all of these, and the shell can do them. So this
extension does them for the app and passes everything to it over D-Bus.

## Clipboard access

This extension reads your clipboard. While the Clipboard app is running, it
tells the app about each copy so the app can keep it in your history. The
extension passes clipboard content only to the Clipboard app on the same
computer, over D-Bus, and sends nothing online itself.

The Clipboard app keeps your history on your computer. If you sign in to the
app, it also syncs your history to your account so your other devices have it.

## What it does

| | |
|---|---|
| Watches the clipboard | While the app runs, each copy is announced to the app with its formats and the app it was made in. The app reads the formats it keeps. |
| Holds the shortcut | `show-panel` in its settings, empty until the user chooses one. The app offers Alt+V with a button in its welcome screens and in Settings, and sets it only when that button is pressed. When the shortcut is pressed, the app opens its panel; if the app is not running, it is started. |
| Pastes | Remembers the app that was in front, and on the app's request gives it the focus back and presses its paste keys with a virtual keyboard. It never types into a window that did not take the focus. |
| Places the panel | The panel floats above other windows, opens centred on the screen with the pointer, and then where it was last put. |
| Top-bar icon | A click opens the panel; the right button opens the menu: Open Clipboard, Welcome Screens, Start at Login, Quit Clipboard. |

## Supported versions

GNOME Shell 46 (Ubuntu 24.04) and 50 (Ubuntu 26.04).

## The D-Bus interface

Name `com.provelopers.Clipboard.Helper`, object `/com/provelopers/Clipboard/Helper`,
interface `com.provelopers.Clipboard.Helper1` (see `helper.js` for the XML).
The app's connection holds `com.provelopers.Clipboard.App`; the clipboard,
paste, shortcut and menu calls are answered only for whoever holds that name.

| Method | |
|---|---|
| `GetVersion() → u` | The protocol version, 2 (1 had no asking of a sandboxed app). |
| `ReadClipboard(s mimeType) → ay` | The clipboard in one format. |
| `WriteClipboard(s mimeType, ay data)` | Put content on the clipboard. Not announced back as a copy. |
| `ClearClipboard()` | |
| `GetPasteTarget() → (s appId, s wmClass, s title)` | The window a paste goes to. |
| `Paste(s keys) → b` | `"ctrl+v"`, `"ctrl+shift+v"`… False when the window did not take the focus. |
| `GetShortcut() → as`, `SetShortcut(as)` | The panel's shortcut, as GTK accelerators. |
| `SetMenuState(a{sv})` | `startAtLogin` (b) and `welcome` (b), shown in the menu. |
| `GetActivationToken() → s` | Lets the app's next window take the focus. |

### A sandboxed app (the snap)

The app installed as a snap may answer calls on the session bus but not make
them, so it cannot call the methods above. For it the direction is turned
round: the helper calls the app's own object, `/com/provelopers/Clipboard/App`
(interface `com.provelopers.Clipboard.App1`), on the name
`com.provelopers.Clipboard.App`, as soon as that name appears.

| Method on the app | |
|---|---|
| `NextRequest() → (u id, s member, as strings, ay data)` | Answered only when the app wants something: one of the methods above by name, with its arguments as strings and bytes. The helper asks again at once. An app that is not sandboxed has no such object, and the helper stops asking. |
| `Reply(u id, b succeeded, as strings, ay data)` | The result of request `id`; when it failed, the reason is the first string. |

What can be asked for is exactly the list of methods above, and nothing is
handed to anyone but the holder of the app's name.

| Signal | |
|---|---|
| `ClipboardChanged(as mimeTypes, s appId, s appName)` | |
| `ShortcutPressed(s activationToken)` | |
| `MenuActivated(s action, s activationToken)` | `show`, `welcome`, `start-at-login`, `quit`. The menu shows Welcome Screens only while the app's menu state has `welcome: true`. |
| `Started()` | The helper (re)started, after the shell restarted. |

## Installing from this repository

```sh
cp -r clipboard-helper@provelopers.net ~/.local/share/gnome-shell/extensions/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/clipboard-helper@provelopers.net/schemas
```

Log out and back in (GNOME Shell on Wayland loads a newly installed extension
only at the next login), then:

```sh
gnome-extensions enable clipboard-helper@provelopers.net
```

`journalctl -f -o cat /usr/bin/gnome-shell` shows its errors.

## Problems and questions

Please open an issue in this repository.

## Licence

GPL-2.0-or-later, see `LICENSE`. This covers the extension only; the Clipboard
app is a separate program.
