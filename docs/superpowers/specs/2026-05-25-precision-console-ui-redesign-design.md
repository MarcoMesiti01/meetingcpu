# Precision Console UI Redesign Design

## Goal

Restyle the existing meeting transcription dashboard into a sharp, modern dark interface using emerald accents and visibly layered depth. The redesign must preserve the current dashboard layout and all existing recording, transcription, upload, model selection, and saved-file behavior.

## Scope

This is a presentation-layer redesign of the browser application. The existing arrangement remains intact:

- header and state indicator
- session controls
- status metrics
- audio upload section
- transcript workspace
- saved file summary

Implementation should primarily modify `apps/web/src/styles.css`. Changes to `apps/web/src/App.tsx` are allowed only when a small presentation-only class or wrapper is needed to target the approved styling. No behavior, data flow, control labels, or API interaction should change.

## Selected Direction: Precision Console

The selected direction is a restrained dark control-console aesthetic. It uses clear depth, angular precision, and purposeful emerald emphasis rather than large decorative effects.

Two alternative directions were considered and rejected:

- Emerald Glass: brighter translucent layers and larger glows would be more dramatic but distract from transcript reading.
- Industrial Grid: severe outlines and near-zero warmth would be crisp but overly harsh for an everyday meeting tool.

Precision Console balances strong visual character with long-form readability and clear control states.

## Visual System

The page background will use near-black charcoal tones with a restrained emerald cast or radial highlight near the top of the viewport. This introduces depth around the dashboard while keeping the transcript area calm.

Panels will become graphite surfaces elevated from the page through:

- tight corner radii
- thin dark-cool borders with subtle top-edge highlights
- layered drop shadows
- controlled internal contrast for nested surfaces

Text hierarchy will use near-white headings, cool muted supporting copy, and emerald micro-labels or emphasis. The accent must remain focused: green indicates key actions, active or focused controls, and positive or live state details rather than coloring all surfaces.

Interaction styling will be precise and visible:

- focused form controls gain a clear emerald border or ring
- hoverable controls gain modest elevation and edge brightness
- primary controls may use a restrained emerald glow
- disabled controls remain clearly inactive and readable

## Component Treatment

### Header And Status

The header remains in place. The eyebrow label becomes an emerald orientation marker, while the title uses high-contrast light text. The existing status pill becomes a defined raised or illuminated badge. Recording and successful states receive green emphasis; warning and error states continue to use distinct caution/error colors so state is not communicated by green alone.

### Session Controls

The session controls panel is the strongest foreground surface. Text input and model selection elements become inset dark controls with precise borders and visible keyboard focus treatment.

`Start recording` becomes the primary elevated emerald button with a controlled highlight and shadow. `Stop and finalize` and any reload control remain secondary raised dark actions with emerald-accented interaction states. The existing action hierarchy and availability rules remain unchanged.

### Metrics

The metrics panel becomes a compact instrumentation surface. Individual metrics are separated by thin dividers or inset row treatment. Labels are muted and compact; values have stronger brightness for quick scanning. Session identifiers must still wrap safely when long.

### Upload

The upload panel remains a horizontal secondary zone. Its supporting text is subdued relative to primary controls. The file chooser uses the secondary sharp button language and retains a distinct disabled appearance.

### Transcript Workspace

The transcript area remains the largest and quietest surface. It will use a darker inset reading field with enough contrast for sustained reading. Transcript segments retain their structure, with fine separators and emerald emphasis for speaker identity and/or timestamps. Decorative glow must not interfere with text legibility.

### Saved Files

The saved-file section stays visually supporting rather than dominant. Paths use restrained high-contrast text, with a technical/monospaced character where appropriate, and remain readable against the dark surface.

## Responsive And Accessibility Requirements

The current dashboard layout behavior is retained at narrower widths: multi-column areas stack according to existing breakpoints, buttons remain usable, and transcript reading space remains appropriate.

The redesigned theme must preserve:

- strong text contrast on dark surfaces
- a clearly visible keyboard focus state on interactive controls
- distinct disabled controls
- state communication that does not rely only on emerald coloring
- readable warning and error feedback

## Implementation Boundaries

No changes are intended to:

- application state transitions
- recording or chunk handling
- API requests or event subscriptions
- transcript rendering logic
- model loading or selection behavior
- saved-session output

Any markup adjustment should be minimal, style-driven, and covered by existing component behavior tests.

## Validation

Implementation validation will include:

1. Run the existing web application tests to confirm control and transcript behavior remains unchanged.
2. Run the web build to identify styling or compilation regressions.
3. Inspect the rendered UI in the running browser application for:
   - dark background and elevated panel hierarchy
   - emerald primary-action clarity
   - readable transcript and file-path surfaces
   - status and error differentiation
   - focus and disabled-state visibility
   - narrow viewport layout and control usability

