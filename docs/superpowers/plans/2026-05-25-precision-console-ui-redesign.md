# Precision Console UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the existing transcription dashboard as a dark, sharp Precision Console interface with emerald accents and layered depth while preserving all existing behavior and layout.

**Architecture:** Keep the React component and application state flow intact. Implement the approved visual system through the existing centralized stylesheet, then verify regression behavior through the web test/build commands and verify presentation in the running browser interface.

**Tech Stack:** React 19, TypeScript, Vite, CSS, Vitest, Testing Library

---

## File Map

- Modify: `apps/web/src/styles.css` - owns the page theme, panel surfaces, controls, interaction states, transcript reading surface, saved-file treatment, and responsive styling.
- Reference only: `apps/web/src/App.tsx` - existing semantic structure and class names used by the stylesheet; do not modify unless an approved treatment cannot be expressed with current selectors.
- Reference only: `apps/web/src/App.test.tsx` - existing interaction regression coverage; no new application behavior is introduced by this styling change.

### Task 1: Establish The Presentation-Only Baseline

**Files:**
- Test: `apps/web/src/App.test.tsx`
- Reference: `apps/web/src/App.tsx`
- Reference: `apps/web/src/styles.css`

- [ ] **Step 1: Confirm there is no functional UI change to drive with a new behavior test**

Review the existing class structure in `App.tsx` and the interaction tests in `App.test.tsx`. Confirm the redesign can style these existing hooks without altering text, roles, enabled/disabled rules, event handlers, or state rendering:

```tsx
<main className="app-shell">
  <header className="topbar">
    <p className="eyebrow">Local transcription</p>
    <span className={`status-pill status-${status}`} role="status" aria-live="polite">
      {formatStatus(status)}
    </span>
  </header>
  <section className="dashboard-grid" aria-label="Recording dashboard">
    <div className="panel control-panel">...</div>
    <aside className="panel metrics-panel" aria-label="Status metrics">...</aside>
  </section>
  <section className="panel upload-panel">...</section>
  <section className="panel result-panel" aria-label="Transcription result">...</section>
  <section className="panel session-panel" aria-label="Saved files">...</section>
</main>
```

Expected: The approved styling can be expressed with existing selectors; do not modify `App.tsx` or add a synthetic styling assertion to the behavior suite.

- [ ] **Step 2: Run the existing web test suite as a baseline**

Run:

```powershell
npm.cmd --workspace @meetingcpu/web test
```

Expected: PASS before stylesheet edits. If it does not pass, stop and distinguish a pre-existing failure from this visual change before editing production files.

### Task 2: Implement The Precision Console Theme

**Files:**
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Replace the light global theme with a charcoal and emerald foundation**

Update the root and page surface rules with a palette expressed as CSS custom properties and a subtly lit background:

```css
:root {
  --bg: #080c0c;
  --bg-raised: #0d1313;
  --surface: #111919;
  --surface-raised: #152020;
  --surface-inset: #0b1111;
  --border: #243130;
  --border-highlight: #344340;
  --text: #eef4f2;
  --text-muted: #8d9d99;
  --text-soft: #b7c4c0;
  --emerald: #1fd37f;
  --emerald-bright: #39e591;
  --emerald-deep: #0e9458;
  --emerald-wash: rgba(31, 211, 127, 0.12);
  --warning: #f2bb54;
  --error: #f26a6a;
  color: var(--text);
  background: var(--bg);
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
    sans-serif;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}

body {
  min-width: 320px;
  min-height: 100vh;
  margin: 0;
  background: var(--bg);
}

.app-shell {
  min-height: 100vh;
  padding: 32px 28px;
  background:
    radial-gradient(circle at 48% 0%, rgba(31, 211, 127, 0.11), transparent 38rem),
    linear-gradient(180deg, #090e0e 0%, #070b0b 100%);
}
```

- [ ] **Step 2: Convert typography, status indicators, and panels to the sharp layered treatment**

Apply crisp hierarchy and raised graphite surfaces:

```css
.eyebrow {
  color: var(--emerald);
  font-size: 0.72rem;
  font-weight: 760;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

h1 {
  color: var(--text);
  letter-spacing: -0.035em;
}

h2 {
  color: var(--text);
  letter-spacing: -0.015em;
}

.panel {
  border: 1px solid var(--border);
  border-top-color: var(--border-highlight);
  border-radius: 5px;
  padding: 20px;
  background: linear-gradient(145deg, var(--surface-raised), var(--surface));
  box-shadow:
    0 18px 42px rgba(0, 0, 0, 0.3),
    0 1px 0 rgba(255, 255, 255, 0.035) inset;
}

.status-pill {
  border: 1px solid var(--border-highlight);
  border-radius: 4px;
  color: var(--text-soft);
  background: var(--surface-raised);
  box-shadow: 0 8px 18px rgba(0, 0, 0, 0.22);
  letter-spacing: 0.03em;
}

.status-recording,
.status-complete {
  border-color: rgba(31, 211, 127, 0.45);
  color: var(--emerald-bright);
  background: rgba(31, 211, 127, 0.1);
  box-shadow: 0 0 20px rgba(31, 211, 127, 0.13);
}

.status-finalizing,
.status-transcribing,
.status-loading {
  border-color: rgba(83, 163, 202, 0.45);
  color: #7ccbea;
  background: rgba(52, 130, 170, 0.14);
}

.status-error {
  border-color: rgba(242, 106, 106, 0.45);
  color: #ff9191;
  background: rgba(242, 106, 106, 0.1);
}
```

- [ ] **Step 3: Restyle controls, actions, metrics, and feedback surfaces**

Implement inset controls, emerald focus states, raised buttons, instrument-like metrics, and distinctive warning/error surfaces:

```css
.field {
  color: var(--text-muted);
  font-size: 0.78rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.field input,
.field select {
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  background: var(--surface-inset);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22) inset;
}

.field input:focus,
.field select:focus,
.file-control:focus-within {
  border-color: var(--emerald);
  outline: 2px solid rgba(31, 211, 127, 0.22);
  outline-offset: 1px;
}

button,
.file-control {
  border-radius: 4px;
  transition:
    transform 120ms ease,
    border-color 120ms ease,
    box-shadow 120ms ease,
    background-color 120ms ease;
}

.primary-action {
  border-color: rgba(59, 229, 145, 0.48);
  color: #05120d;
  background: linear-gradient(180deg, var(--emerald-bright), var(--emerald-deep));
  box-shadow:
    0 10px 24px rgba(31, 211, 127, 0.22),
    0 1px 0 rgba(255, 255, 255, 0.3) inset;
}

.secondary-action,
.file-control {
  border-color: var(--border-highlight);
  color: var(--text-soft);
  background: linear-gradient(180deg, #192322, #101817);
  box-shadow: 0 8px 17px rgba(0, 0, 0, 0.2);
}

.metric {
  border: 1px solid rgba(52, 67, 64, 0.6);
  border-radius: 4px;
  padding: 11px 12px;
  background: rgba(8, 13, 13, 0.38);
}

.metric span {
  color: var(--text-muted);
  letter-spacing: 0.1em;
}

.metric strong {
  color: var(--text);
}

.model-warning {
  border-color: rgba(242, 187, 84, 0.42);
  color: #ffd67e;
  background: rgba(242, 187, 84, 0.09);
}

.error-message {
  border-color: rgba(242, 106, 106, 0.44);
  color: #ff9d9d;
  background: rgba(242, 106, 106, 0.09);
}
```

- [ ] **Step 4: Make transcript and saved-file surfaces readable and distinctly inset**

Keep long-form content quiet while applying emerald detail only to structural metadata:

```css
.transcript-box {
  border: 1px solid #202d2b;
  border-radius: 4px;
  color: var(--text-soft);
  background: var(--surface-inset);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2) inset;
}

.transcript-segment {
  border-bottom: 1px solid rgba(49, 66, 63, 0.56);
}

.transcript-segment strong {
  color: var(--emerald-bright);
}

.transcript-segment span,
.path-list span {
  color: var(--text-muted);
}

.path-list span {
  border: 1px solid rgba(41, 55, 52, 0.7);
  border-radius: 4px;
  padding: 9px 11px;
  background: rgba(8, 13, 13, 0.4);
  font-family: "Cascadia Mono", "Consolas", monospace;
}
```

- [ ] **Step 5: Preserve the existing compact responsive layout**

Maintain the current stacking rules and adjust mobile spacing only to suit elevated surfaces:

```css
@media (max-width: 820px) {
  .app-shell {
    padding: 20px 14px;
  }

  .panel {
    padding: 16px;
  }

  .topbar,
  .upload-panel,
  .result-header {
    align-items: stretch;
    flex-direction: column;
  }

  .dashboard-grid,
  .control-grid {
    grid-template-columns: 1fr;
  }

  .action-row button,
  .file-control {
    width: 100%;
  }
}
```

Expected: The application retains the same hierarchy and controls while rendering as a charcoal and emerald console with pronounced but restrained depth.

### Task 3: Verify Behavior And Presentation

**Files:**
- Verify: `apps/web/src/styles.css`
- Verify: `apps/web/src/App.test.tsx`

- [ ] **Step 1: Run the web regression tests**

Run:

```powershell
npm.cmd --workspace @meetingcpu/web test
```

Expected: PASS with the existing interaction tests unchanged, demonstrating that styling work did not alter recording, upload, session, or transcript behavior.

- [ ] **Step 2: Build the web app**

Run:

```powershell
npm.cmd --workspace @meetingcpu/web run build
```

Expected: PASS with Vite producing the web build without CSS or TypeScript compilation errors.

- [ ] **Step 3: Inspect the application in the browser at desktop width**

Run the local web application and inspect the interface at its Vite URL. Verify:

- near-black background with restrained emerald lighting
- clearly raised graphite panels without layout changes
- emerald `Start recording` button as the strongest action
- distinct secondary action, warning, error, and status styles
- transcript content remains comfortable to read
- saved paths remain readable and supporting

Expected: Each approved Precision Console component treatment is visually present and usable.

- [ ] **Step 4: Inspect focus and narrow viewport states**

Using the running interface, navigate controls with the keyboard and reduce the viewport below `820px`. Verify:

- keyboard focus is clearly visible in emerald
- disabled controls remain distinguishable from available controls
- status/error communication does not rely on green
- panels stack as before
- actions expand cleanly to mobile width
- transcript reading area remains usable

Expected: Accessibility and responsive requirements in the design specification are met.

- [ ] **Step 5: Commit the stylesheet implementation**

```powershell
git add -- 'apps/web/src/styles.css'
git commit -m "feat: apply precision console ui theme"
```

Expected: The implementation commit includes only the reviewed styling change, unless visual verification identified and justified a minimal presentation-only `App.tsx` hook.

