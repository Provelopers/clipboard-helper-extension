// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Provelopers

// The Clipboard icon in the top bar, the Linux counterpart of the Windows tray
// icon and the Mac menu bar item: a click opens the panel, a right click opens
// the menu.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export const ClipboardIndicator = GObject.registerClass(
class ClipboardIndicator extends PanelMenu.Button {
    _init(extensionPath, activate) {
        super._init(0.5, 'Clipboard', false);
        this._activate = activate;

        this.add_child(new St.Icon({
            gicon: Gio.FileIcon.new(Gio.File.new_for_path(`${extensionPath}/icons/clipboard-symbolic.svg`)),
            style_class: 'system-status-icon',
        }));

        this.menu.addAction('Open Clipboard', () => this._activate('show'));
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        // Shown once the app says it has welcome screens to show (onboarding).
        this._welcome = this.menu.addAction('Welcome Screens', () => this._activate('welcome'));
        this._welcome.visible = false;
        this._startAtLogin = new PopupMenu.PopupSwitchMenuItem('Start at Login', false);
        this._startAtLogin.connect('toggled', () => this._activate('start-at-login'));
        this.menu.addMenuItem(this._startAtLogin);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Quit Clipboard', () => this._activate('quit'));
    }

    update(state) {
        this._startAtLogin.setToggleState(Boolean(state?.startAtLogin));
        this._welcome.visible = Boolean(state?.welcome);
    }

    vfunc_event(event) {
        // A plain click opens the panel; the right button and touch-and-hold
        // keep the usual menu.
        if (event.type() === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_PRIMARY) {
            this.menu.close();
            this._activate('show');
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_event(event);
    }
});
