// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Provelopers

// The Clipboard icon in the top bar: a click opens the app's panel, a right
// click opens the menu.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// GNOME 46 opens the menu in PanelMenu.Button's vfunc_event. GNOME 50 has no
// such handler; a click gesture opens the menu there instead.
const BUTTON_HANDLES_EVENTS = Object.prototype.hasOwnProperty.call(PanelMenu.Button.prototype, 'vfunc_event');

export const ClipboardIndicator = GObject.registerClass(
class ClipboardIndicator extends PanelMenu.Button {
    constructor(extensionPath, activate) {
        super(0.5, 'Clipboard', false);
        this._activate = activate;
        // The gesture would open the menu on a plain click too, so it is turned
        // off and vfunc_event below decides per button.
        if (!BUTTON_HANDLES_EVENTS) this._clickGesture.set_enabled(false);

        this.add_child(new St.Icon({
            gicon: Gio.FileIcon.new(Gio.File.new_for_path(`${extensionPath}/icons/clipboard-symbolic.svg`)),
            style_class: 'system-status-icon',
        }));

        this.menu.addAction('Open Clipboard', () => this._activate('show'));
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._welcome = this.menu.addAction('Welcome Screens', () => this._activate('welcome'));
        this._welcome.visible = false;
        this._startAtLogin = new PopupMenu.PopupSwitchMenuItem('Start at Login', false);
        this._startAtLogin.connect('toggled', () => this._activate('start-at-login'));
        this.menu.addMenuItem(this._startAtLogin);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Quit Clipboard', () => this._activate('quit'));
    }

    update(state) {
        this._startAtLogin.setToggleState(state.startAtLogin);
        this._welcome.visible = Boolean(state.welcome);
    }

    vfunc_event(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_PRIMARY) {
            this.menu.close();
            this._activate('show');
            return Clutter.EVENT_STOP;
        }
        if (BUTTON_HANDLES_EVENTS) return super.vfunc_event(event);
        if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
            this.menu.toggle();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
});
