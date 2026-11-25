// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Provelopers

// The Clipboard app's helper inside GNOME Shell.
//
// Wayland does not let an ordinary app read the clipboard while another app is
// in front, hold a shortcut for the whole desktop, bring its own window to the
// front, or type into another app. The shell can do all of these, so this
// object does them on the app's behalf and talks to it over D-Bus:
//
//   - every copy is announced (ClipboardChanged), and the app reads the parts
//     it wants (ReadClipboard); the app writes the clipboard the same way;
//   - the shortcut the user chooses in the app (none until then) is announced as ShortcutPressed,
//     with a token that lets the app's panel take the focus;
//   - the app that was in front is remembered, and Paste gives it the focus
//     back and presses its paste keys;
//   - the panel window is kept above other windows and placed on the screen
//     with the pointer.
//
// Only the running Clipboard app may read or write the clipboard or paste:
// every such call is checked against the D-Bus name the app holds
// (com.provelopers.Clipboard.App).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const APP_ID = 'com.provelopers.Clipboard';
/** The name the app's D-Bus connection to this helper holds while it runs. */
export const APP_BUS_NAME = 'com.provelopers.Clipboard.App';
export const BUS_NAME = 'com.provelopers.Clipboard.Helper';
export const OBJECT_PATH = '/com/provelopers/Clipboard/Helper';
export const PROTOCOL_VERSION = 1;

/** The panel's window title; the app's other windows (editor, welcome screens) have their own. */
const PANEL_TITLE = 'Clipboard';

const INTERFACE_XML = `
<node>
  <interface name="com.provelopers.Clipboard.Helper1">
    <method name="GetVersion">
      <arg type="u" direction="out" name="version"/>
    </method>
    <method name="ReadClipboard">
      <arg type="s" direction="in" name="mimeType"/>
      <arg type="ay" direction="out" name="data"/>
    </method>
    <method name="WriteClipboard">
      <arg type="s" direction="in" name="mimeType"/>
      <arg type="ay" direction="in" name="data"/>
    </method>
    <method name="ClearClipboard"/>
    <method name="GetPasteTarget">
      <arg type="s" direction="out" name="appId"/>
      <arg type="s" direction="out" name="wmClass"/>
      <arg type="s" direction="out" name="title"/>
    </method>
    <method name="Paste">
      <arg type="s" direction="in" name="keys"/>
      <arg type="b" direction="out" name="pasted"/>
    </method>
    <method name="GetShortcut">
      <arg type="as" direction="out" name="accelerators"/>
    </method>
    <method name="SetShortcut">
      <arg type="as" direction="in" name="accelerators"/>
    </method>
    <method name="SetMenuState">
      <arg type="a{sv}" direction="in" name="state"/>
    </method>
    <method name="GetActivationToken">
      <arg type="s" direction="out" name="token"/>
    </method>
    <signal name="ClipboardChanged">
      <arg type="as" name="mimeTypes"/>
      <arg type="s" name="appId"/>
      <arg type="s" name="appName"/>
    </signal>
    <signal name="ShortcutPressed">
      <arg type="s" name="activationToken"/>
    </signal>
    <signal name="MenuActivated">
      <arg type="s" name="action"/>
      <arg type="s" name="activationToken"/>
    </signal>
    <signal name="FocusedAnotherApp"/>
    <signal name="Started"/>
  </interface>
</node>`;

/** How long after the app writes the clipboard the change it causes is still its own. */
const OWN_WRITE_MS = 1000;

/** How long Paste waits for the app it pastes into to take the focus. */
const FOCUS_WAIT_MS = 600;

/** Keys a paste may press, by the names the app sends ("ctrl+shift+v"). */
const KEYVALS = {
    ctrl: Clutter.KEY_Control_L,
    shift: Clutter.KEY_Shift_L,
    alt: Clutter.KEY_Alt_L,
    super: Clutter.KEY_Super_L,
    insert: Clutter.KEY_Insert,
    v: Clutter.KEY_v,
};

/** The keyvals of "ctrl+shift+v", or null when any part is not one the helper presses. */
export function parseKeys(keys) {
    const parts = String(keys).toLowerCase().split('+').map(part => part.trim());
    if (parts.length === 0 || parts.some(part => !(part in KEYVALS))) return null;
    return parts.map(part => KEYVALS[part]);
}

export class ClipboardHelper {
    constructor(settings, {onAppRunningChanged, onMenuState} = {}) {
        this._settings = settings;
        this._onAppRunningChanged = onAppRunningChanged ?? (() => {});
        this._onMenuState = onMenuState ?? (() => {});
        this._appOwner = null;
        this._lastTarget = null;
        this._lastTargetUnmanagedId = 0;
        this._ownWriteUntil = 0;
        this._panelPosition = null;
        this._signals = [];
        this._timeouts = new Set();
        this._virtualKeyboard = null;
        // Whether the window that had the focus last was the app's own, so a move
        // to another app can be told from the panel keeping its own focus.
        this._focusWasOurs = false;
    }

    get appRunning() {
        return this._appOwner !== null;
    }

    start() {
        this._dbus = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, this);
        this._dbus.export(Gio.DBus.session, OBJECT_PATH);
        this._nameId = Gio.bus_own_name_on_connection(
            Gio.DBus.session, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null);
        // The app holds its name on the bus while it runs.
        this._watchId = Gio.bus_watch_name_on_connection(
            Gio.DBus.session, APP_BUS_NAME, Gio.BusNameWatcherFlags.NONE,
            (_connection, _name, owner) => this._setAppOwner(owner),
            () => this._setAppOwner(null));

        const selection = global.display.get_selection();
        this._connect(selection, 'owner-changed', (_selection, type, source) => this._onOwnerChanged(type, source));
        this._connect(global.display, 'notify::focus-window', () => this._onFocusChanged());
        this._connect(global.display, 'window-created', (_display, window) => this._onWindowCreated(window));
        this._onFocusChanged();

        Main.wm.addKeybinding('show-panel', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._onShortcut());

        this._dbus.emit_signal('Started', null);
    }

    destroy() {
        Main.wm.removeKeybinding('show-panel');
        for (const [object, id] of this._signals) object.disconnect(id);
        this._signals = [];
        for (const id of this._timeouts) GLib.source_remove(id);
        this._timeouts.clear();
        this._forgetTarget();
        if (this._watchId) Gio.bus_unwatch_name(this._watchId);
        if (this._nameId) Gio.bus_unown_name(this._nameId);
        this._dbus?.unexport();
        this._dbus = null;
        // A virtual input device stays registered with the compositor until it is
        // disposed; waiting for garbage collection would leave a stray keyboard
        // behind after the extension is turned off.
        this._virtualKeyboard?.run_dispose();
        this._virtualKeyboard = null;
    }

    /** Wait, with the timer removed in destroy() if the helper is turned off meanwhile. */
    _sleep(ms) {
        return new Promise(resolve => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._timeouts.delete(id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._timeouts.add(id);
        });
    }

    /** Connect a signal that destroy() disconnects if it is still connected then. */
    _connect(object, signal, handler) {
        const id = object.connect(signal, handler);
        this._signals.push([object, id]);
        return id;
    }

    /** Disconnect a signal connected with _connect before destroy(). */
    _disconnect(object, id) {
        object.disconnect(id);
        this._signals = this._signals.filter(([other, otherId]) => other !== object || otherId !== id);
    }

    _setAppOwner(owner) {
        const wasRunning = this.appRunning;
        this._appOwner = owner;
        if (wasRunning !== this.appRunning) this._onAppRunningChanged(this.appRunning);
    }

    /** Whether a call comes from the running Clipboard app. */
    _fromApp(invocation) {
        if (this._appOwner !== null && invocation.get_sender() === this._appOwner) return true;
        invocation.return_dbus_error('com.provelopers.Clipboard.Helper.Error.NotAllowed',
            'Only the Clipboard app may do this.');
        return false;
    }

    _isOurs(window) {
        if (!window) return false;
        return window.get_gtk_application_id?.() === APP_ID || window.get_wm_class() === APP_ID;
    }

    // ---- The clipboard --------------------------------------------------------

    _onOwnerChanged(type, source) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD || !source) return;
        // Copies are announced only to the Clipboard app, and only while it runs.
        if (!this.appRunning) return;
        // The app's own write (a paste, or Copy): not a new copy.
        if (GLib.get_monotonic_time() / 1000 < this._ownWriteUntil) {
            this._ownWriteUntil = 0;
            return;
        }
        const mimeTypes = source.get_mimetypes() ?? [];
        if (mimeTypes.length === 0) return;
        const app = Shell.WindowTracker.get_default().focus_app;
        this._dbus?.emit_signal('ClipboardChanged', new GLib.Variant('(asss)', [
            mimeTypes, app?.get_id() ?? '', app?.get_name() ?? '',
        ]));
    }

    GetVersion() {
        return PROTOCOL_VERSION;
    }

    ReadClipboardAsync([mimeType], invocation) {
        if (!this._fromApp(invocation)) return;
        St.Clipboard.get_default().get_content(St.ClipboardType.CLIPBOARD, mimeType, (_clipboard, bytes) => {
            const data = bytes ?? new GLib.Bytes(new Uint8Array(0));
            invocation.return_value(GLib.Variant.new_tuple([
                GLib.Variant.new_from_bytes(new GLib.VariantType('ay'), data, true),
            ]));
        });
    }

    WriteClipboardAsync([mimeType, data], invocation) {
        if (!this._fromApp(invocation)) return;
        this._ownWriteUntil = GLib.get_monotonic_time() / 1000 + OWN_WRITE_MS;
        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, mimeType, new GLib.Bytes(data));
        invocation.return_value(null);
    }

    ClearClipboardAsync(_parameters, invocation) {
        if (!this._fromApp(invocation)) return;
        this._ownWriteUntil = GLib.get_monotonic_time() / 1000 + OWN_WRITE_MS;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, '');
        invocation.return_value(null);
    }

    // ---- The app to paste into ------------------------------------------------

    _onFocusChanged() {
        const window = global.display.focus_window;
        const wasOurs = this._focusWasOurs;
        this._focusWasOurs = this._isOurs(window);
        if (!window || this._focusWasOurs) return;
        // Somewhere to paste: an app's window, not the shell's own surfaces.
        const type = window.get_window_type();
        if (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG &&
            type !== Meta.WindowType.MODAL_DIALOG) return;
        // The panel had the focus and another app now has it: the app steps the
        // panel aside, as on the Mac and Windows. A menu or a drag keeps the
        // focus on the app, so this does not fire for the panel's own doings.
        if (wasOurs && this.appRunning) this._dbus?.emit_signal('FocusedAnotherApp', null);
        if (window === this._lastTarget) return;
        this._forgetTarget();
        this._lastTarget = window;
        this._lastTargetUnmanagedId = window.connect('unmanaged', () => this._forgetTarget());
    }

    _forgetTarget() {
        if (this._lastTarget && this._lastTargetUnmanagedId) this._lastTarget.disconnect(this._lastTargetUnmanagedId);
        this._lastTarget = null;
        this._lastTargetUnmanagedId = 0;
    }

    GetPasteTargetAsync(_parameters, invocation) {
        if (!this._fromApp(invocation)) return;
        const window = this._lastTarget;
        const app = window ? Shell.WindowTracker.get_default().get_window_app(window) : null;
        invocation.return_value(new GLib.Variant('(sss)', [
            app?.get_id() ?? '', window?.get_wm_class() ?? '', window?.get_title() ?? '',
        ]));
    }

    PasteAsync([keys], invocation) {
        if (!this._fromApp(invocation)) return;
        this._paste(keys).then(
            pasted => invocation.return_value(new GLib.Variant('(b)', [pasted])),
            error => {
                logError(error, 'Clipboard Helper: paste failed');
                invocation.return_value(new GLib.Variant('(b)', [false]));
            });
    }

    async _paste(keys) {
        const keyvals = parseKeys(keys);
        const target = this._lastTarget;
        if (!keyvals || !target) return false;

        Main.activateWindow(target);
        // Never type into a different app than the one meant: if it does not
        // take the focus (it closed, or is on a locked screen), the clip stays
        // on the clipboard for the user to paste.
        const deadline = GLib.get_monotonic_time() + FOCUS_WAIT_MS * 1000;
        while (global.display.focus_window !== target && GLib.get_monotonic_time() < deadline) await this._sleep(20);
        if (global.display.focus_window !== target) return false;
        // Let the app settle its focus inside the window before the keys arrive.
        await this._sleep(60);
        this._press(keyvals);
        return true;
    }

    _keyboard() {
        if (!this._virtualKeyboard) {
            const backend = global.stage?.context?.get_backend?.() ?? Clutter.get_default_backend();
            this._virtualKeyboard = backend.get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        }
        return this._virtualKeyboard;
    }

    /** Press the keys in order and let go of them in reverse, like a person would. */
    _press(keyvals) {
        const keyboard = this._keyboard();
        const now = () => GLib.get_monotonic_time();
        // Alt can still be down from Alt+V, and Ctrl+Alt+V is a different shortcut.
        const [, , modifiers] = global.get_pointer();
        if (modifiers & Clutter.ModifierType.MOD1_MASK) {
            keyboard.notify_keyval(now(), Clutter.KEY_Alt_L, Clutter.KeyState.RELEASED);
            keyboard.notify_keyval(now(), Clutter.KEY_Alt_R, Clutter.KeyState.RELEASED);
        }
        for (const keyval of keyvals) keyboard.notify_keyval(now(), keyval, Clutter.KeyState.PRESSED);
        for (const keyval of [...keyvals].reverse()) keyboard.notify_keyval(now(), keyval, Clutter.KeyState.RELEASED);
    }

    // ---- The shortcut and the menu --------------------------------------------

    /** A token that lets the app's next window take the focus, as a launcher's would. */
    _activationToken() {
        try {
            const context = global.create_app_launch_context(global.get_current_time(), -1);
            const info = Gio.DesktopAppInfo.new(`${APP_ID}.desktop`);
            return context.get_startup_notify_id(info, []) ?? '';
        } catch (error) {
            // Not installed with its .desktop file (a development build): the
            // panel is brought to the front when it appears instead.
            return '';
        }
    }

    GetActivationTokenAsync(_parameters, invocation) {
        if (!this._fromApp(invocation)) return;
        invocation.return_value(new GLib.Variant('(s)', [this._activationToken()]));
    }

    _onShortcut() {
        if (Main.overview.visible) Main.overview.hide();
        if (!this.appRunning) {
            this._launchApp();
            return;
        }
        this._dbus?.emit_signal('ShortcutPressed', new GLib.Variant('(s)', [this._activationToken()]));
    }

    /** From the top-bar icon: "show", "welcome", "start-at-login" or "quit". */
    activateMenu(action) {
        if (!this.appRunning) {
            if (action === 'show') this._launchApp();
            return;
        }
        this._dbus?.emit_signal('MenuActivated', new GLib.Variant('(ss)', [action, this._activationToken()]));
    }

    _launchApp() {
        const info = Gio.DesktopAppInfo.new(`${APP_ID}.desktop`);
        if (!info) {
            Main.notify('Clipboard', 'The Clipboard app is not installed.');
            return;
        }
        info.launch([], global.create_app_launch_context(global.get_current_time(), -1));
    }

    GetShortcut() {
        return this._settings.get_strv('show-panel');
    }

    SetShortcutAsync([accelerators], invocation) {
        if (!this._fromApp(invocation)) return;
        this._settings.set_strv('show-panel', accelerators);
        invocation.return_value(null);
    }

    SetMenuStateAsync([state], invocation) {
        if (!this._fromApp(invocation)) return;
        const unpacked = {};
        for (const [key, value] of Object.entries(state)) unpacked[key] = value.deepUnpack();
        this._onMenuState(unpacked);
        invocation.return_value(null);
    }

    // ---- The app's windows ----------------------------------------------------

    /**
     * The app's windows come to the front when they open, as the user asked
     * for them. The panel also floats above other windows, opens centred on
     * the screen with the pointer, and afterwards where the user last put it.
     */
    _onWindowCreated(window) {
        if (!this._isOurs(window)) return;
        const actor = window.get_compositor_private();
        if (!actor) return;
        const id = this._connect(actor, 'first-frame', () => {
            this._disconnect(actor, id);
            this._present(window);
        });
    }

    _present(window) {
        if (window.get_title() === PANEL_TITLE && window.get_window_type() === Meta.WindowType.NORMAL) {
            window.make_above();
            this._place(window);
            const positionId = this._connect(window, 'position-changed', () => {
                const rect = window.get_frame_rect();
                this._panelPosition = {x: rect.x, y: rect.y};
            });
            const unmanagedId = this._connect(window, 'unmanaged', () => {
                this._disconnect(window, positionId);
                this._disconnect(window, unmanagedId);
            });
        }
        Main.activateWindow(window);
    }

    _place(window) {
        const monitor = global.display.get_current_monitor();
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);
        const frame = window.get_frame_rect();
        let x, y;
        if (this._panelPosition && this._inside(this._panelPosition, frame, area)) {
            ({x, y} = this._panelPosition);
        } else {
            x = area.x + Math.round((area.width - frame.width) / 2);
            y = area.y + Math.round((area.height - frame.height) / 2);
        }
        window.move_frame(true, x, y);
    }

    /** Whether the panel at this position would be on the work area. */
    _inside(position, frame, area) {
        return position.x >= area.x && position.y >= area.y &&
            position.x + frame.width <= area.x + area.width &&
            position.y + frame.height <= area.y + area.height;
    }
}
