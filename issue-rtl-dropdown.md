## Title: Dropdown menu on "Add New Patient" split button isn't mirrored in RTL (Arabic)

## Description
In the Arabic (RTL) locale, the "Add New Patient" split-button group mirrors correctly, but its dropdown menu does not. The menu stays anchored to the physical right edge of the caret and extends leftward, away from the button, instead of sitting underneath it.

## Steps to reproduce
1. Switch the app language to Arabic (page `dir="rtl"`).
2. Go to Patients page.
3. Click the caret on the "إضافة مريض جديد" split button.

## Expected behavior
The menu is aligned to the caret's edge so it opens beneath the button group, mirroring the LTR layout (where the menu's right edge lines up with the caret and extends under the button).

## Actual behavior
The menu opens beside the caret and extends to the left into empty space, detached from the button. The menu's contents (right-aligned text, icon on the right) are already RTL-correct. Only the menu's position is wrong.

## Suspected cause
The dropdown menu's alignment is physical rather than logical. Likely candidates:
- The LTR Bootstrap stylesheet is loaded alongside `dir="rtl"` instead of `bootstrap.rtl.min.css`
- A hard-coded `dropdown-menu-end` / `right: 0` / `left: auto`
- A fixed Popper placement instead of a direction-aware one (`bottom-end`)

## Suggested fix
Use logical alignment so the menu follows document direction:
```css
.dropdown-menu {
  inset-inline-end: 0;
  inset-inline-start: auto;
}
```
Or, if RTL support is handled via the LTR stylesheet, toggle the alignment class based on `document.documentElement.dir`.

## Environment
- Browser / OS: Chrome, Firefox / Windows
- Bootstrap version: 5.3.x
- Locale: ar (RTL)

## Acceptance criteria
- [ ] In RTL, the menu opens directly under the split-button group
- [ ] LTR behavior is unchanged
- [ ] Verified on other dropdowns that use the same alignment class