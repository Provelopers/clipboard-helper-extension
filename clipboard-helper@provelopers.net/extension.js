// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Provelopers

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ClipboardHelper} from './helper.js';
import {ClipboardIndicator} from './indicator.js';

export default class ClipboardHelperExtension extends Extension {
    enable() {
        this._menuState = {startAtLogin: false};
        this._helper = new ClipboardHelper(this.getSettings(), {
            onAppRunningChanged: running => this._showIndicator(running),
            onMenuState: state => {
                Object.assign(this._menuState, state);
                this._indicator?.update(this._menuState);
            },
        });
        this._helper.start();
        this._showIndicator(this._helper.appRunning);
    }

    disable() {
        this._showIndicator(false);
        this._helper.destroy();
        this._helper = null;
        this._menuState = null;
    }

    _showIndicator(show) {
        if (show && !this._indicator) {
            this._indicator = new ClipboardIndicator(this.path, action => this._helper.activateMenu(action));
            this._indicator.update(this._menuState);
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        } else if (!show && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
