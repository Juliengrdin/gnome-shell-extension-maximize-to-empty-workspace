/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// What to do with a window once the resize announced by `size-change` has
// actually been applied (`size-changed`). Acting on `size-changed` rather
// than `size-change` is what makes this work with clients that apply the new
// state asynchronously (e.g. GNOME Calendar).
const PLACE = 'place';
const BACK = 'back';

export default class MaximizeToEmptyWorkspaceExtension extends Extension {
    enable() {
        // ids of the windows this extension moved to a workspace of their own
        this._placed = new Set();
        // window id -> PLACE | BACK, set in `size-change`, consumed in `size-changed`
        this._pending = new Map();

        global.window_manager.connectObject(
            'map', (_wm, actor) => this._onMap(actor),
            'destroy', (_wm, actor) => this._onDestroy(actor),
            'minimize', (_wm, actor) => this._onMinimize(actor),
            'unminimize', (_wm, actor) => this._onUnminimize(actor),
            'size-change', (_wm, actor, change, oldFrameRect) =>
                this._onSizeChange(actor, change, oldFrameRect),
            'size-changed', (_wm, actor) => this._onSizeChanged(actor),
            this);
    }

    disable() {
        global.window_manager.disconnectObject(this);
        this._placed = null;
        this._pending = null;
    }

    // ---- window classification --------------------------------------------

    // Only ordinary windows that live on a single workspace are managed.
    _isCandidate(win) {
        return win.window_type === Meta.WindowType.NORMAL &&
            !win.is_on_all_workspaces();
    }

    // Maximized in both directions, i.e. covering the whole work area.
    // Meta.Window.get_maximized() no longer exists (Mutter 47+); the two
    // properties are available on every supported version.
    _isFullyMaximized(win) {
        return win.maximized_horizontally && win.maximized_vertically;
    }

    // Does `w` count as occupying its workspace on `monitor`? Windows that
    // are on every workspace (docks, "Always on Visible Workspace", and, with
    // workspaces-only-on-primary, everything on secondary monitors) never do.
    _occupies(w, monitor) {
        return !w.is_on_all_workspaces() && w.get_monitor() === monitor;
    }

    _hasWindowsOn(workspace, monitor) {
        return workspace.list_windows().some(w => this._occupies(w, monitor));
    }

    // ---- workspace lookup ---------------------------------------------------

    // Index of the first workspace with no window on `monitor`, or -1.
    _firstFreeWorkspace(manager, monitor) {
        const n = manager.get_n_workspaces();
        for (let i = 0; i < n; i++) {
            if (!this._hasWindowsOn(manager.get_workspace_by_index(i), monitor))
                return i;
        }
        return -1;
    }

    // Index of the nearest workspace other than `current` with a window on
    // `monitor`, looking backwards first, or -1.
    _lastOccupiedWorkspace(manager, current, monitor) {
        for (let i = current - 1; i >= 0; i--) {
            if (this._hasWindowsOn(manager.get_workspace_by_index(i), monitor))
                return i;
        }
        const n = manager.get_n_workspaces();
        for (let i = current + 1; i < n; i++) {
            if (this._hasWindowsOn(manager.get_workspace_by_index(i), monitor))
                return i;
        }
        return -1;
    }

    // ---- placing ------------------------------------------------------------

    // Give `win` a workspace of its own. The window itself is never moved (it
    // may not be fully mapped yet); instead the workspaces are reordered so
    // that `win` keeps its workspace object, and all *other* windows are moved
    // away from it.
    _placeOnWorkspace(win) {
        const workspace = win.get_workspace();
        if (!workspace)
            return;

        const monitor = win.get_monitor();
        const others = workspace.list_windows()
            .filter(w => w !== win && this._occupies(w, monitor));
        if (others.length === 0)
            return; // already alone on this monitor

        const display = win.get_display();
        const manager = display.get_workspace_manager();
        const current = workspace.index();
        const free = this._firstFreeWorkspace(manager, monitor);
        if (free === -1 || free === current)
            return;
        const freeWorkspace = manager.get_workspace_by_index(free);

        if (Meta.prefs_get_workspaces_only_on_primary()) {
            // Secondary monitors have no workspaces of their own.
            if (monitor !== display.get_primary_monitor())
                return;

            if (current < free) {
                // Insert the free workspace right here; every workspace in
                // between shifts one index further. With dynamic workspaces
                // this is the normal case: the free one is the trailing empty
                // workspace.
                manager.reorder_workspace(freeWorkspace, current);
            } else {
                // A free workspace before the current one (static workspaces
                // only): swap the two.
                manager.reorder_workspace(workspace, free);
                manager.reorder_workspace(freeWorkspace, current);
            }
            others.forEach(w => w.change_workspace_by_index(current, false));
        } else {
            // Every monitor has workspaces: swap the current and the free
            // workspace and exchange their windows, so that the other monitors
            // show what they showed on the free workspace.
            const othersAll = workspace.list_windows()
                .filter(w => w !== win && !w.is_on_all_workspaces());
            const freeWindows = freeWorkspace.list_windows()
                .filter(w => !w.is_on_all_workspaces());

            manager.reorder_workspace(workspace, free);
            manager.reorder_workspace(freeWorkspace, current);

            othersAll.forEach(w => w.change_workspace_by_index(current, false));
            freeWindows.forEach(w => w.change_workspace_by_index(free, false));
        }

        this._placed.add(win.get_id());
    }

    // Undo _placeOnWorkspace: once `win` is the only window left on its
    // workspace, move that workspace to the nearest occupied one and merge
    // them. There is no history: "back" means the closest workspace that has
    // windows on this monitor.
    _backTo(win) {
        if (!this._placed.delete(win.get_id()))
            return; // we never moved this window

        const workspace = win.get_workspace();
        if (!workspace || win.is_on_all_workspaces())
            return;

        const display = win.get_display();
        const monitor = win.get_monitor();
        const onlyPrimary = Meta.prefs_get_workspaces_only_on_primary();
        if (onlyPrimary && monitor !== display.get_primary_monitor())
            return;

        // Only leave when nothing else is using this workspace: on this
        // monitor, or, when every monitor has workspaces, on any monitor.
        const stillUsed = workspace.list_windows().some(w =>
            w !== win && !w.is_on_all_workspaces() &&
            (!onlyPrimary || w.get_monitor() === monitor));
        if (stillUsed)
            return;

        const manager = display.get_workspace_manager();
        const current = workspace.index();
        const last = this._lastOccupiedWorkspace(manager, current, monitor);
        if (last === -1)
            return;
        const toMove = manager.get_workspace_by_index(last).list_windows()
            .filter(w => !w.is_on_all_workspaces() &&
                (!onlyPrimary || w.get_monitor() === monitor));

        // Move our workspace to the occupied one's position and pull its
        // windows over, so that `win` again keeps its workspace object.
        manager.reorder_workspace(workspace, last);
        toMove.forEach(w => w.change_workspace_by_index(last, false));
    }

    // ---- window manager signals ---------------------------------------------

    _onMap(actor) {
        const win = actor.meta_window;
        if (this._isCandidate(win) && this._isFullyMaximized(win))
            this._placeOnWorkspace(win);
    }

    _onDestroy(actor) {
        const win = actor.meta_window;
        this._pending.delete(win.get_id());
        this._backTo(win);
    }

    _onMinimize(actor) {
        this._backTo(actor.meta_window);
    }

    _onUnminimize(actor) {
        const win = actor.meta_window;
        if (this._isCandidate(win) && this._isFullyMaximized(win))
            this._placeOnWorkspace(win);
    }

    _onSizeChange(actor, change, oldFrameRect) {
        const win = actor.meta_window;
        if (!this._isCandidate(win))
            return;

        let action = null;
        switch (change) {
        case Meta.SizeChange.MAXIMIZE:
            if (this._isFullyMaximized(win))
                action = PLACE;
            break;
        case Meta.SizeChange.FULLSCREEN:
            action = PLACE;
            break;
        case Meta.SizeChange.UNMAXIMIZE: {
            // The maximize flags are already cleared at this point. Compare
            // the old frame with the work area to ignore windows that were
            // only partially maximized (tiled).
            const workArea = win.get_work_area_for_monitor(win.get_monitor());
            if (workArea.equal(oldFrameRect))
                action = BACK;
            break;
        }
        case Meta.SizeChange.UNFULLSCREEN:
            if (!this._isFullyMaximized(win))
                action = BACK;
            break;
        default:
            break;
        }

        if (action)
            this._pending.set(win.get_id(), action);
    }

    _onSizeChanged(actor) {
        const win = actor.meta_window;
        const id = win.get_id();
        const action = this._pending.get(id);
        if (action === undefined)
            return;
        this._pending.delete(id);

        if (action === PLACE)
            this._placeOnWorkspace(win);
        else
            this._backTo(win);
    }
}
