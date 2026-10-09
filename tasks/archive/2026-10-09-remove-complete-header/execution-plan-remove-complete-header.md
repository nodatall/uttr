# Simplify the completed meeting header

Goal: Remove redundant completed-session labels and reduce the empty space above the meeting controls.

Please review this before I start.
Tell me what is wrong, missing, or out of order.

Deliver implementation instruction:
When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

## Context

- Remove the completed-state text and icon above the summary content, and reduce excess top padding.
- Keep completion state behavior and the summary content unchanged.

Visual mockup: [ui-mockup-remove-complete-header.html](ui-mockup-remove-complete-header.html)

## Steps

### 1. Remove completed-state labels

- [x] Hide the top “Complete” status label and remove the summary header’s “Summary” text and checkmark for completed sessions.
- [x] Reduce the completed meeting workspace top spacing by 16 pixels, from 28 pixels to 12 pixels, without changing spacing in other states or screens.
- [x] Verify the rendered completed meeting screen and run the required frontend checks.
