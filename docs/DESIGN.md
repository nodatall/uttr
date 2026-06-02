---
name: Uttr Design System
version: 1
description: Shared visual rules for Uttr's desktop app, overlay, onboarding, and session workspace.
tokens:
  colors:
    background: "#0d1117"
    background_deep: "#060a12"
    surface: "#050a12"
    surface_soft: "rgba(255, 255, 255, 0.04)"
    surface_strong: "rgba(255, 255, 255, 0.08)"
    border: "rgba(255, 255, 255, 0.08)"
    border_strong: "rgba(255, 255, 255, 0.12)"
    text: "#e6edf3"
    text_muted: "#93a0b3"
    primary: "#67d7a3"
    primary_strong: "#1d9b64"
    warning: "#f4c46f"
    danger: "#faa2ca"
  typography:
    sans: "Space Grotesk, Avenir Next, Segoe UI, sans-serif"
    mono: "JetBrains Mono, Fira Code, SFMono-Regular, monospace"
    root_size: "15px"
    body_line_height: "24px"
    weights:
      regular: 400
      medium: 500
      semibold: 600
      bold: 700
  spacing:
    xs: "4px"
    sm: "8px"
    md: "12px"
    lg: "16px"
    xl: "24px"
    xxl: "32px"
  radius:
    control: "12px"
    group: "18px"
    panel: "20px"
    pill: "999px"
  elevation:
    flat: "none"
    raised: "0 14px 40px rgba(0, 0, 0, 0.28)"
    glow_primary: "0 0 0 1px rgba(103, 215, 163, 0.28), 0 12px 28px rgba(29, 155, 100, 0.18)"
components:
  button:
    radius: "{tokens.radius.control}"
    background: "{tokens.surface_soft}"
    border: "{tokens.colors.border}"
  toggle:
    track_on: "{tokens.colors.primary_strong}"
    track_off: "rgba(255, 255, 255, 0.09)"
  input:
    radius: "{tokens.radius.control}"
    background: "{tokens.surface_soft}"
    border: "{tokens.colors.border_strong}"
---

# Overview

Uttr is a compact desktop utility for dictation and transcription. The app should feel quiet, fast, and native to macOS without becoming a generic web dashboard.

The default product surfaces are practical tools: settings, onboarding, model/API configuration, history, file transcription, recording overlays, and the future session workspace. Build the actual workflow first. Do not introduce marketing-style hero sections, decorative layout, or explanatory empty states unless the surface is the public marketing site.

Use this file as the shared design source of truth. It should stay broad enough to guide new screens and specific enough to stop agents from inventing new palettes, spacing systems, or component styles.

# Colors

Uttr uses a dark neutral base with restrained green accents.

- `background` is the app base: `#0d1117`.
- `background_deep` is used for darker panels and window edges: `#060a12`.
- `surface` and `surface_soft` are for settings groups, menus, inputs, and cards.
- `text` is the default foreground: `#e6edf3`.
- `text_muted` is for secondary copy, inactive nav, captions, and metadata: `#93a0b3`.
- `primary` is the bright Uttr accent: `#67d7a3`.
- `primary_strong` is the active/control green: `#1d9b64`.
- `warning` is reserved for locked, caution, or billing-related states.
- `danger` is reserved for destructive or stop-recording states.

Keep green as an accent, not a full-page theme. Avoid one-hue screens. Use neutral dark surfaces first, then green only to signal active, enabled, selected, or primary actions.

# Typography

Use `Space Grotesk` for app UI and `JetBrains Mono` only for code-like values, paths, logs, and fixed-width technical text.

- Body text: `15px`, regular, `24px` line height.
- Compact row labels: `14px` to `15px`, medium.
- Section labels: `11px`, uppercase, `0.18em` letter spacing, muted.
- Page titles: `24px` to `28px`, semibold.
- Overlay labels: `12px` to `15px`, medium or semibold depending on state.

Do not scale text with viewport width. Keep letter spacing normal except for small uppercase labels.

# Layout

Desktop app screens use a sidebar plus a main working area when navigation is needed. The main area should be dense, scannable, and built for repeated use.

- App surfaces fill the viewport.
- Settings-style pages use a persistent left rail and a scrollable content panel.
- Rows and controls align on a clear horizontal grid.
- Group related settings in one container with internal dividers instead of separate floating cards.
- For tool surfaces and future session windows, prefer full-height work areas over decorative page sections.
- Keep compact overlays independent from full-window session workflows.

Use stable dimensions for fixed-format controls such as icon buttons, shortcut pills, toggles, progress states, and recording overlays so dynamic state changes do not resize the layout.

# Elevation and Depth

Depth should be subtle. Use borders, soft transparency, and small shadows to separate panels from the dark background.

- Default app surfaces are mostly flat.
- Raised panels can use `tokens.elevation.raised`.
- Active or selected surfaces can use a faint green inset/glow, not a large glow effect.
- Avoid decorative gradient blobs, floating orbs, bokeh, or purely atmospheric backgrounds.

# Shapes

Uttr uses modest rounded corners.

- Controls: `12px`.
- Groups: `18px`.
- Main panels: `20px`.
- Status pills and toggles: fully rounded.
- Cards should generally stay at `8px` radius or less unless matching an existing Uttr settings/overlay container.

Do not nest cards inside cards. A settings group may contain rows; a modal may contain controls; repeated items may be cards. Page sections should not become card stacks.

# Components

## Navigation

The desktop app sidebar is compact and persistent. Inactive items are muted; active items use restrained green background, icon, and dot treatment. Keep labels short and predictable.

## Settings Groups

Settings groups are single rounded containers with internal row dividers. Each row has label content on the left and the control on the right. Descriptions should be short and only visible when they help the user decide.

## Buttons

Use icon buttons for icon-native actions such as stop, pause, reset, delete, copy, and refresh. Use text buttons for commands that need words, such as "Save key" or "Check for updates".

Primary actions use green sparingly. Destructive or stop actions use the danger token family. Disabled buttons should visibly disable pointer interaction and reduce contrast.

## Inputs and Dropdowns

Inputs and dropdowns share the same dark translucent surface, subtle border, and `12px` radius. Placeholder text is muted. Links inside settings should use pointer cursors and clear hover states.

## Toggles

Toggles are for binary settings. On state uses `primary_strong`; off state uses muted translucent white. Do not use a toggle where a command button or segmented control is clearer.

## Pills

Pills are for status, selected model/provider state, and compact metadata. Avoid redundant pills when the section title or card grouping already says the same thing.

## Recording Overlay

The recording overlay should feel immediate and lightweight. It may use the app font and accent colors, but it must not look like a settings card. Warm, recording, transcribing, and processing states should be visually distinct without adding heavy borders.

## Ask Selection Panel

Ask Selection is an interactive floating panel, not a recording overlay state. It should use the settings-style dark translucent surface, subtle border, compact top-right close button, and the shared rose loader for thinking/loading. Do not show a title in the panel. The result text is the primary surface; clicking it copies the answer while keeping the answer visible and showing only a small `Copied` status in the header.

## Session Workspace

A full-system session window should prioritize the live summary and meeting/session output. Raw transcript is available on request, not the default focus. Use a full-window working layout, not a boxed mockup inside another box.

# Do's and Don'ts

Do:

- Reuse the tokens in this file before adding new colors, radii, or shadows.
- Match existing app density and control behavior.
- Keep labels short and concrete.
- Use muted secondary text instead of long explanatory paragraphs.
- Make active, disabled, loading, and error states explicit.
- Validate UI changes visually in the app or browser when practical.

Don't:

- Build landing pages inside the desktop app.
- Add decorative hero sections, illustration panels, gradient blobs, or floating card grids.
- Replace grouped settings rows with independent setting cards.
- Overfit this file to one screenshot, viewport, or temporary mockup.
- Use a single dominant hue across an entire screen.
- Add hidden behavior without an obvious visible affordance unless the existing product deliberately keeps it hidden.

# Implementation Notes

- App shell: `src/App.tsx`
- Global visual tokens and base CSS: `src/App.css`
- Sidebar: `src/components/Sidebar.tsx`
- Settings groups: `src/components/ui/SettingsGroup.tsx`
- Setting rows: `src/components/ui/SettingContainer.tsx`
- Buttons: `src/components/ui/Button.tsx`
- Inputs: `src/components/ui/Input.tsx`
- Toggles: `src/components/ui/ToggleSwitch.tsx`
- Recording overlay: `src/overlay/RecordingOverlay.tsx`
- Overlay styles: `src/overlay/RecordingOverlay.css`

When production UI changes, update this file to describe the durable rule, not the one-off screenshot that prompted the change.
