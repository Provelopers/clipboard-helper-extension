// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Provelopers

// Wayland does not let an app read the clipboard in the background, hold a
// desktop-wide shortcut, or type into another app. The shell can, so this
// object does those for the Clipboard app and talks to it over D-Bus. Only the
// holder of the app's bus name may read or write the clipboard or paste.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const APP_ID = 'com.provelopers.Clipboard';
export const APP_BUS_NAME = 'com.provelopers.Clipboard.App';
export const BUS_NAME = 'com.provelopers.Clipboard.Helper';
export const OBJECT_PATH = '/com/provelopers/Clipboard/Helper';
// A sandboxed (snap) app cannot call the helper, so the helper calls this
// object of the app's to fetch its requests.
export const APP_OBJECT_PATH = '/com/provelopers/Clipboard/App';
export const APP_INTERFACE = 'com.provelopers.Clipboard.App1';
export const PROTOCOL_VERSION = 2;

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

// A clipboard change this soon after the app's own write is not a new copy.
const OWN_WRITE_MS = 1000;
const FOCUS_WAIT_MS = 600;

const KEYVALS = {
    ctrl: Clutter.KEY_Control_L,
    shift: Clutter.KEY_Shift_L,
    alt: Clutter.KEY_Alt_L,
    super: Clutter.KEY_Super_L,
    insert: Clutter.KEY_Insert,
    v: Clutter.KEY_v,
};

// "ctrl+shift+v" to keyvals; null when a part is not in KEYVALS.
export function parseKeys(keys) {
    const parts = String(keys).toLowerCase().split('+').map(part => part.trim());
    if (parts.length === 0 || parts.some(part => !(part in KEYVALS))) return null;
    return parts.map(part => KEYVALS[part]);
}

export class ClipboardHelper {
    constructor(settings, {onAppRunningChanged, onMenuState}) {
        this._settings = settings;
        this._onAppRunningChanged = onAppRunningChanged;
        this._onMenuState = onMenuState;
        this._appOwner = null;
        this._asking = null;
        this._lastTarget = null;
        this._lastTargetUnmanagedId = 0;
        this._ownWriteUntil = 0;
        this._panelPosition = null;
        this._signals = [];
        this._timeouts = new Set();
        this._virtualKeyboard = null;
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
        this._stopAsking();
        Gio.bus_unwatch_name(this._watchId);
        Gio.bus_unown_name(this._nameId);
        this._dbus.unexport();
        this._dbus = null;
        this._virtualKeyboard = null;
    }

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

    _connect(object, signal, handler) {
        const id = object.connect(signal, handler);
        this._signals.push([object, id]);
        return id;
    }

    _disconnect(object, id) {
        object.disconnect(id);
        this._signals = this._signals.filter(([other, otherId]) => other !== object || otherId !== id);
    }

    _setAppOwner(owner) {
        const wasRunning = this.appRunning;
        if (owner !== this._appOwner) {
            this._stopAsking();
            if (owner !== null) this._startAsking();
        }
        this._appOwner = owner;
        if (wasRunning !== this.appRunning) this._onAppRunningChanged(this.appRunning);
    }

    _fromApp(invocation) {
        if (this._appOwner !== null && invocation.get_sender() === this._appOwner) return true;
        invocation.return_dbus_error('com.provelopers.Clipboard.Helper.Error.NotAllowed',
            'Only the Clipboard app may do this.');
        return false;
    }

    _isOurs(window) {
        if (!window) return false;
        return window.get_gtk_application_id() === APP_ID || window.get_wm_class() === APP_ID;
    }

    _onOwnerChanged(type, source) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD || !source) return;
        if (!this.appRunning) return;
        if (GLib.get_monotonic_time() / 1000 < this._ownWriteUntil) {
            this._ownWriteUntil = 0;
            return;
        }
        const mimeTypes = source.get_mimetypes();
        if (mimeTypes.length === 0) return;
        const app = Shell.WindowTracker.get_default().focus_app;
        this._dbus.emit_signal('ClipboardChanged', new GLib.Variant('(asss)', [
            mimeTypes, app?.get_id() ?? '', app?.get_name() ?? '',
        ]));
    }

    GetVersion() {
        return PROTOCOL_VERSION;
    }

    _read(mimeType) {
        return new Promise(resolve => {
            St.Clipboard.get_default().get_content(St.ClipboardType.CLIPBOARD, mimeType, (_clipboard, bytes) => {
                // St frees these bytes when the callback returns, so copy them
                // now; bytes is null when the format is not on the clipboard.
                resolve(new GLib.Bytes(bytes?.get_data() ?? new Uint8Array(0)));
            });
        });
    }

    _write(mimeType, data) {
        this._ownWriteUntil = GLib.get_monotonic_time() / 1000 + OWN_WRITE_MS;
        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, mimeType, new GLib.Bytes(data));
    }

    _clear() {
        this._ownWriteUntil = GLib.get_monotonic_time() / 1000 + OWN_WRITE_MS;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, '');
    }

    ReadClipboardAsync([mimeType], invocation) {
        if (!this._fromApp(invocation)) return;
        this._read(mimeType).then(data => invocation.return_value(GLib.Variant.new_tuple([
            GLib.Variant.new_from_bytes(new GLib.VariantType('ay'), data, true),
        ])));
    }

    WriteClipboardAsync([mimeType, data], invocation) {
        if (!this._fromApp(invocation)) return;
        this._write(mimeType, data);
        invocation.return_value(null);
    }

    ClearClipboardAsync(_parameters, invocation) {
        if (!this._fromApp(invocation)) return;
        this._clear();
        invocation.return_value(null);
    }

    _onFocusChanged() {
        const window = global.display.focus_window;
        const wasOurs = this._focusWasOurs;
        this._focusWasOurs = this._isOurs(window);
        if (!window || this._focusWasOurs) return;
        const type = window.get_window_type();
        if (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG &&
            type !== Meta.WindowType.MODAL_DIALOG) return;
        // The focus left the panel for another app: the app hides the panel.
        if (wasOurs && this.appRunning) this._dbus.emit_signal('FocusedAnotherApp', null);
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

    _target() {
        const window = this._lastTarget;
        const app = window ? Shell.WindowTracker.get_default().get_window_app(window) : null;
        return [app?.get_id() ?? '', window?.get_wm_class() ?? '', window?.get_title() ?? ''];
    }

    GetPasteTargetAsync(_parameters, invocation) {
        if (!this._fromApp(invocation)) return;
        invocation.return_value(new GLib.Variant('(sss)', this._target()));
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
        // Never type into another app than the one meant: give up if the
        // target does not take the focus in time.
        const deadline = GLib.get_monotonic_time() + FOCUS_WAIT_MS * 1000;
        while (global.display.focus_window !== target && GLib.get_monotonic_time() < deadline) await this._sleep(20);
        if (global.display.focus_window !== target) return false;
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

    // A token that lets the app's next window take the focus.
    _activationToken() {
        const info = this._appInfo();
        if (!info) return '';
        const context = global.create_app_launch_context(global.get_current_time(), -1);
        return context.get_startup_notify_id(info, []) ?? '';
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
        this._dbus.emit_signal('ShortcutPressed', new GLib.Variant('(s)', [this._activationToken()]));
    }

    activateMenu(action) {
        if (!this.appRunning) {
            if (action === 'show') this._launchApp();
            return;
        }
        this._dbus.emit_signal('MenuActivated', new GLib.Variant('(ss)', [action, this._activationToken()]));
    }

    // A package names the desktop file after the app; a snap names it after the
    // snap, so that one is found by the window class it declares.
    _appInfo() {
        const apps = Shell.AppSystem.get_default();
        const app = apps.lookup_app(`${APP_ID}.desktop`) ?? apps.lookup_startup_wmclass(APP_ID);
        return app?.get_app_info();
    }

    _launchApp() {
        const info = this._appInfo();
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

    _startAsking() {
        this._asking = new Gio.Cancellable();
        this._ask(this._asking);
    }

    _stopAsking() {
        this._asking?.cancel();
        this._asking = null;
    }

    // The app answers NextRequest only when it has a request, so the call
    // stays open until then. It fails when the app quits, or at once when the
    // app is not sandboxed; either ends the asking until the app starts again.
    _ask(cancellable) {
        Gio.DBus.session.call(APP_BUS_NAME, APP_OBJECT_PATH, APP_INTERFACE, 'NextRequest', null,
            new GLib.VariantType('(usasay)'), Gio.DBusCallFlags.NO_AUTO_START, GLib.MAXINT32, cancellable,
            (connection, result) => {
                let request;
                try {
                    request = connection.call_finish(result);
                } catch (error) {
                    return;
                }
                if (cancellable.is_cancelled()) return;
                this._ask(cancellable);
                const [id, member, strings, data] = request.deepUnpack();
                this._serve(member, strings, data).then(
                    ([replyStrings, replyData]) => this._answer(cancellable, id, true, replyStrings, replyData),
                    error => this._answer(cancellable, id, false, [error.message]));
            });
    }

    // Returns [strings, bytes] for the reply.
    async _serve(member, strings, data) {
        switch (member) {
        case 'GetVersion':
            return [[String(PROTOCOL_VERSION)]];
        case 'ReadClipboard':
            return [[], await this._read(strings[0])];
        case 'WriteClipboard':
            this._write(strings[0], data);
            return [[]];
        case 'ClearClipboard':
            this._clear();
            return [[]];
        case 'GetPasteTarget':
            return [this._target()];
        case 'Paste':
            return [[String(await this._paste(strings[0]))]];
        case 'GetShortcut':
            return [this.GetShortcut()];
        case 'SetShortcut':
            this._settings.set_strv('show-panel', strings);
            return [[]];
        case 'SetMenuState': {
            const state = {};
            for (const entry of strings) {
                const [key, value] = entry.split('=');
                state[key] = value === 'true';
            }
            this._onMenuState(state);
            return [[]];
        }
        case 'GetActivationToken':
            return [[this._activationToken()]];
        default:
            throw new Error(`unknown request ${member}`);
        }
    }

    _answer(cancellable, id, succeeded, strings, data = new GLib.Bytes(new Uint8Array(0))) {
        if (cancellable.is_cancelled()) return;
        const reply = GLib.Variant.new_tuple([
            GLib.Variant.new_uint32(id),
            GLib.Variant.new_boolean(succeeded),
            GLib.Variant.new_strv(strings),
            GLib.Variant.new_from_bytes(new GLib.VariantType('ay'), data, true),
        ]);
        Gio.DBus.session.call(APP_BUS_NAME, APP_OBJECT_PATH, APP_INTERFACE, 'Reply', reply,
            null, Gio.DBusCallFlags.NO_AUTO_START, -1, cancellable, null);
    }

    // The app's windows come to the front when they open. The panel also stays
    // above other windows and opens centred, or where the user last put it.
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

    _inside(position, frame, area) {
        return position.x >= area.x && position.y >= area.y &&
            position.x + frame.width <= area.x + area.width &&
            position.y + frame.height <= area.y + area.height;
    }
}
