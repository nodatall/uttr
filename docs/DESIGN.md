# Uttr Settings Design Source

This file describes the current Uttr Settings UI. It is a reverse-spec, not a redesign brief. Implementations that use this file should recreate the current UI as-is before proposing any visual changes.

## Evidence

- Source viewport screenshot: `tasks/mockups/settings-design-loop/settings-current.png`
- Full-height reference screenshot: `tasks/mockups/settings-design-loop/settings-current-fullheight.png`
- Balsamiq-style wireframe: `tasks/mockups/settings-design-loop/settings-balsamiq.html`
- Source metrics: `tasks/mockups/settings-design-loop/settings-current-metrics.json`

The source capture uses the current React/Tauri Settings implementation at the Tauri main-window size of `920 x 760`. The taller reference uses the same render at `920 x 1500` only to expose below-the-fold Settings rows. The captured state uses current local non-secret settings values: expired trial, Pro locked, General active, `handy_keys`, transcribe shortcut `fn`, copy shortcut `command+fn`, microphone `DJI MIC MINI`, push-to-talk on, autostart on, tray icon on, always-on microphone on, post-processing off, history limit `20`, and recording retention `preserve_limit`.

## Product Shape

Settings is a compact native desktop utility surface. It should feel like a dark, quiet macOS preferences window, not a marketing page or broad web dashboard. The first screen is the working Settings UI with a left navigation rail and a scrollable settings panel. No hero, explanatory landing content, decorative cards, or empty illustration space belongs here.

The current default active section is `General`. The active Settings page combines the General, Sound, Transcription, and History groups in one scrollable content panel.

## App Frame

- Window target: `920px` wide by `760px` tall, matching `src-tauri/tauri.conf.json`.
- Minimum window size: `920px x 760px`.
- App root fills the full viewport and clips overflow.
- Outer background: vertical near-black gradient from `rgba(10, 15, 25, 0.985)` to `rgba(6, 10, 18, 0.96)`.
- Global text color: `#e6edf3`.
- Font: `"Space Grotesk", "Avenir Next", "Segoe UI", sans-serif`.
- Root font size: `15px`; body line height: `24px`; letter spacing is normal except uppercase section labels.
- Desktop layout: horizontal flex row with `20px` side/bottom padding, `4px` top padding, and `16px` gap between sidebar and content.
- Rendered `920 x 760` border-box targets:
  - Sidebar: `x=19`, `y=4`, `w=214`, `h=736`.
  - Content panel: `x=248`, `y=4`, `w=654`, `h=736`.
  - First section label: `x=275`, `y=31`.
  - First settings group: `x=271`, `y=67`, `w=607`.
  - First row label baseline area starts near `x=287`, `y=85`.

## Sidebar

The sidebar is the left persistent navigation and billing/status area.

- Position in `920 x 760` viewport: starts near `x=19`, `y=4`.
- Width: `214px`; fixed minimum width `214px`.
- Height: fills the app content area.
- Shape: `18px` radius, `1px` border using `white / 0.06`.
- Background: `rgba(4, 9, 15, 0.45)`.
- Padding: `12px` horizontal, `16px` vertical.
- Header text: `Uttr`, uppercase, `11px`, medium, letter spacing `0.18em`, color `text / 0.35`.

Visible navigation items in the captured state:

1. `General` active.
2. `API Keys`.
3. `History`.
4. `File Transcription`.

`Models` is hidden when model controls are unavailable; `Debug` is hidden when `debug_mode` is false.

Navigation row styling:

- Row height is about `38px`.
- Full row width is `190px` inside the sidebar.
- Row radius: `12px`.
- Row padding: `12px` horizontal, `10px` vertical.
- Row content: status dot, `17px` lucide icon, label.
- Label text: `13.125px`, medium, truncated if needed.
- Inactive text: `text / 0.72`; hover uses `white / 0.04`.
- Active background: horizontal gradient from `rgba(29, 155, 100, 0.2)` to `rgba(29, 155, 100, 0.08)`.
- Active border illusion: inset `1px` shadow using `rgba(103, 215, 163, 0.32)`.
- Active dot: `6px`, `#67d7a3`, with soft green glow.
- Active icon: `#67d7a3`.

Sidebar footer:

- A top divider uses `white / 0.06`.
- Footer text size is `11.25px` to `13.125px`.
- Locked/free state shows an `Upgrade to Pro` button, not `Manage subscription`.
- Upgrade button is `175px x 56px`, rounded about `9px`, border `#67d7a3` with transparent green background.
- Upgrade primary text: `Upgrade to Pro`, `13.125px`, medium, `#e6edf3`.
- Upgrade caption: `Trial ended - $5/month`, muted at about `11.25px`.
- Below it: `Check for updates`, then `v0.1.10`, both muted.

## Content Panel

The content panel is the right scrollable settings surface.

- Position in `920 x 760` viewport: starts near `x=248`, `y=4`.
- Width in current viewport: about `654px`.
- Shape: `20px` radius, `1px` border using `white / 0.06`.
- Background: `rgba(5, 10, 18, 0.56)`.
- Inset top highlight: `inset 0 1px 0 rgba(255,255,255,0.03)`.
- The panel owns vertical scrolling with the custom thin scrollbar.
- Inner content is centered and constrained to `max-width: 768px`.
- Inner content padding: about `24px` horizontal and `28px` vertical on desktop.
- Section vertical gap: `24px`.

The first viewport should show the full General group, the Sound title, Microphone row, Always-On Microphone row, and the top of the full-system audio row. Lower rows continue in the scrollable panel.

## Section Labels

Section labels are small, quiet, and uppercase.

- Element: `h2`.
- Text transform: uppercase.
- Font size: `11px`.
- Font weight: medium.
- Letter spacing: `0.18em`.
- Color: `text / 0.34`.
- Horizontal offset: `4px` from the group edge.
- Bottom gap to group: `12px` to `16px`.

Visible section labels:

- `General`
- `Sound`
- `Transcription`
- `History`

## Settings Groups

Each settings group is a single rounded container with internal dividers. Do not render individual setting rows as separate floating cards.

- Group width in current viewport: about `607px`.
- Group radius: `18px`.
- Group border: `1px solid white / 0.07`.
- Group background: `rgba(255, 255, 255, 0.022)`.
- Group inset highlight: `inset 0 1px 0 rgba(255,255,255,0.02)`.
- Rows divide with `1px solid white / 0.06`.
- Group overflow remains visible so dropdown menus can escape.

Standard row:

- Minimum height: `56px`.
- Layout: label left, control right.
- Padding renders as approximately `15px` horizontal and `10px` to `12px` vertical depending on whether the right control forces extra height.
- Desktop gap between label and control: `24px`.
- Label column max width: `58%`.
- Setting title: `15px`, `20px` line height, medium, color `text / 0.92`.
- Tooltip-mode descriptions are not visible in the normal row layout.
- Standard toggle and shortcut rows render at `56px` tall.
- Rows with `40px` dropdown/input controls render at about `62px` to `63px` tall.

Stacked row:

- Used by the full-system audio setting.
- Title appears above the control area.
- Content stacks vertically with `12px` gaps.
- In locked state, title and description are dimmed.
- In the current locked state, the rendered row is about `131px` tall, not a large card. The next `Mute speakers during recording` row begins immediately below it.

## Controls

Shortcut pill:

- Shape: `6px` radius.
- Border: `mid-gray / 0.8`.
- Background: `mid-gray / 0.1`.
- Text: `13.125px` to `14px`, semibold.
- Padding: about `8px` horizontal and `4px` vertical.
- Visible values in the capture:
  - `fn`
  - `Command + fn`
  - `Shift + Command + 0`
- Reset control sits to the right as a compact icon button.

Toggle:

- Track size: `44px x 24px`.
- Track radius: full pill.
- Off background: `white / 0.09`.
- On background: `#1d9b64` at about `0.9` alpha.
- Focus ring: `#67d7a3 / 0.25`.
- Knob: `20px x 20px`, white, `2px` inset, subtle dark shadow.
- Disabled toggles use opacity `0.5`.

Dropdown:

- Width: `200px`.
- Height: `40px`.
- Radius: `12px`.
- Border: `white / 0.10`.
- Background: `white / 0.04`.
- Text: `13.125px`, medium.
- Padding: about `14px` horizontal and `10px` vertical.
- Chevron sits on the right and rotates when open.

Number input:

- Width: `75px` in the current root font scale (`w-20`).
- Height: `40px`.
- Radius: `12px`.
- Border: `white / 0.10`.
- Background: `white / 0.04`.
- Text is centered by the input's native value area.

Reset icon button:

- Compact square visual footprint, about `26px`.
- Radius: `6px`.
- Normal state has transparent border and muted text.
- Hover uses green translucent background and green border.

## Current Rows

General group:

1. `Transcribe Shortcut` with shortcut pill `fn` and reset icon.
2. `Copy Last Transcript` with shortcut pill `Command + fn` and reset icon.
3. `Push To Talk` toggle on.
4. `Launch on Startup` toggle on.
5. `Show Tray Icon` toggle on.
6. `Application Language` dropdown set to `English (English)`.

Sound group:

1. `Microphone` dropdown set to `DJI MIC MINI` plus reset icon.
2. `Always-On Microphone` toggle on.
3. `Enable system audio recording` stacked locked row:
   - Amber/dark warning box: `Upgrade to Pro to use this feature.`
   - Muted explanatory text: `Upgrade to Pro to use this feature.`
   - Disabled off toggle.
4. `Mute speakers during recording` toggle off.

Transcription group:

1. `Post-Processing Shortcut` with shortcut pill `Shift + Command + 0` and reset icon.
2. `Post Processing` toggle off.

Because post-processing is off, provider, API key, model, prompt, and advanced post-processing controls are not visible.

History group:

1. `History Limit` number input set to `20` followed by `entries`.
2. `Auto-Delete Recordings` dropdown set to `Keep latest 20`.

## Interaction Notes

- Clicking a sidebar item changes the active section and replaces the content panel.
- Clicking a shortcut pill starts shortcut recording; the pill changes to a green highlighted recording state.
- Reset icon resets that setting or binding to its default.
- Dropdowns open below their control and use the same dark glass surface as the app.
- Toggles optimistically move while the setting updates, then show a small spinner over the control if `isUpdating` is true.
- The full-system audio toggle remains disabled when premium access is locked.
- Version text in the sidebar has a hidden five-tap API-key unlock behavior; do not surface this as visible helper text.

## Implementation Anchors

- App shell: `src/App.tsx`
- Sidebar: `src/components/Sidebar.tsx`
- General page composition: `src/components/settings/general/GeneralSettings.tsx`
- Shared group shell: `src/components/ui/SettingsGroup.tsx`
- Shared row shell: `src/components/ui/SettingContainer.tsx`
- Toggle: `src/components/ui/ToggleSwitch.tsx`
- Dropdown: `src/components/ui/Dropdown.tsx`
- Text input: `src/components/ui/Input.tsx`
- Current visual tokens: `src/App.css`
- Primary English copy: `src/i18n/locales/en/translation.json`

## Guardrails

- Do not brighten the page, add marketing copy, add hero content, or split the screen into unrelated cards.
- Do not replace grouped settings containers with isolated setting cards.
- Do not introduce a one-hue palette. The current UI is dark neutral with restrained green accents and occasional amber locked-state warnings.
- Do not make the sidebar wider, the content panel full-bleed, or the row labels larger unless the production layout changes first.
- Do not describe this UI with vague design language. Use the concrete measurements and states above.

## Proof Loop Notes

- `v1`: Created from the current Settings screenshot and current implementation files. The first reconstruction should target the visible `920 x 760` viewport and use the full-height reference only for below-the-fold row coverage.
- `v2`: The first reconstruction placed the content panel and groups a few pixels too far right/down. This spec now includes rendered border-box targets for the sidebar, content panel, first section label, first group, and first row label so a reconstruction can match the current layout without guessing from Tailwind class names alone.
- `v3`: Full-height comparison showed the locked full-system audio row was specified too tall. The spec now records the current locked stacked-row height as about `131px`, with the Mute row immediately following it.
- `v4`: DOM measurements from the current render clarified row heights: standard rows are `56px`, dropdown/input rows are about `62px` to `63px`, and the locked full-system row is about `131px`. The reconstruction should use those measured heights and about `22px` between groups.
