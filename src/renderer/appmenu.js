/**
 * The in-app menu.
 *
 * A frameless window has no menu bar, so this draws one from the same command
 * tree the main process registers accelerators from — nothing here is a second
 * copy of the menu, only a second rendering of it.
 */

import { showMenu } from './menu.js';
import { menuFor, formatAccel } from '../shared/commands.js';

let ctx = null;
export function wire(context) { ctx = context; }

/** Turn one group's items into menu entries. */
function groupItems(group, platform) {
  return group.items.map((it) => {
    if (it.sep) return { sep: true };
    return {
      label: it.label,
      sub: formatAccel(it.accel, platform),
      run: () => (it.role ? ctx.role(it.role) : ctx.command(it.id)),
    };
  });
}

export function openAppMenu(anchor) {
  const platform = ctx.platform();
  const groups = menuFor(platform)
    .filter((g) => g.items.some((it) => !it.sep))
    .map((g) => ({ label: g.label, items: groupItems(g, platform) }));
  showMenu(groups, anchor);
}

/** One group on its own, for a toolbar button that opens straight into it. */
export function openMenuGroup(label, anchor) {
  const platform = ctx.platform();
  const group = menuFor(platform).find((g) => g.label === label);
  if (!group) return;
  showMenu(groupItems(group, platform), anchor);
}
