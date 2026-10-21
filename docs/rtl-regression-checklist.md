# RTL regression checklist (issue #17)

The app loads Bootstrap's **LTR** stylesheet and switches `dir="rtl"` at
runtime, so the directional geometry that ships with the framework needs the
targeted `[dir="rtl"]` overrides documented in `src/styles/main.css` (search
for "RTL button / dropdown geometry"). Run this checklist on every change
that touches buttons, groups, dropdowns or the filter panel, and after any
Bootstrap upgrade.

## Locales

- [ ] English (`en`, LTR) — must look exactly as before an RTL change.
- [ ] Arabic (`ar`, RTL) — geometry mirrored, labels unchanged.

Switch the language from the navbar; both locales must be checked on the
same build.

## Breakpoints

Run every scenario at **360 / 390 / 768 / 1280** px (also 320 px for the
filter panel). Devtools device emulation is fine for radius checks; confirm
the dropdown-anchor changes also with a real tap (touch target sizes).

## Components

| Component | What to verify in RTL |
| --- | --- |
| Patients — "Add New Patient" split button | Main segment: outer radius on the inline-start side, square inner edge. Caret segment: mirror of that, one shared seam, no notch/white gap. When the import feature is off, the control renders as one normally rounded button. |
| Patients — split button dropdown | Menu opens aligned to the trigger's inline-start edge, extends toward the inline-end, never runs off-screen at any breakpoint, does not shift the trigger, closes with Esc and returns focus. |
| Patients table — actions group (view/edit/delete) | One outer radius per flow end, shared internal borders, no double border, delete stays the flow-end member, focus ring visible above neighbours. |
| Users table — actions group (edit/delete) | Same as above. |
| Settings — AI chain row (up / down / delete) | Group mirrors correctly; up/down/delete stays in reading order; delete at the inline-end; red outline intact. |
| Settings — option rows (save/remove) | Buttons mirror individually (they are not a group); no merged/clipped look. |
| Import review — Simple/Advanced mode group | Selected/outline states join seamlessly; mirrors in RTL. |
| Import review — bulk actions group | Same as above. |
| User form — input groups (name/email/password) | Icon prepend has rounded inline-start outer corners, square inner edge; the field keeps its own rounded inline-end outer corners; one seam. |
| Navbar — profile dropdown (`dropdown-menu-end`) | Menu anchors under the trigger aligned to the inline-start edge and stays in the viewport; keyboard: open with Enter, arrows move focus, Esc closes back to the trigger. |
| Dashboard — stat cards | Hint arrow points toward the reading direction; card grids mirror. |
| Patients — filter panel (issue #13) | Popover anchors to the inline-start edge of the Filters button on ≥768px; sheet fills the width below; chips remove from the inline-end. |
| Global search | Suggestion text aligns to the reading direction; the search icon/spinner keep their inset-inline positions. |

## Date inputs

`type="date"` fields (patients filters, patient form) must keep their native
mirrored calendar affordance and remain readable in Arabic — spot-check the
value and the calendar icon position in RTL.

## Known-by-design

- `i.bi { margin-inline: 0.35em !important; }` keeps icon spacing
  direction-agnostic — do not regress it.
- `text-end` on table action columns is intentional (actions sit at the
  flow end); do not "fix" it.
- `.text-start` gets a logical override in RTL because the LTR build ships
  it physically.
