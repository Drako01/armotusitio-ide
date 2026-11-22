---
name: mobile-ux-principles
description: Mandatory UX/UI guidance for web, desktop, IDE and mobile interfaces using Nielsen's ten usability heuristics, accessible states and controls, with conditional mobile interaction guidance.
---

# UX/UI principles for every interface

Apply while designing, implementing or reviewing web, desktop, IDE and mobile interfaces. Preserve approved branding, platform conventions and project requirements. Privacy, security and user control take priority over convenience. The legacy identifier `mobile-ux-principles` remains valid for saved references and `/skill` commands; its scope is general UX, not mobile only.

## Nielsen's ten usability heuristics

Use the [Nielsen Norman Group heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/) as design and review criteria, scaled to the affected interface rather than as a reason to redesign unrelated screens.

### 1. Visibility of system status

Expose actual progress, selection and results promptly. Distinguish authentication from connectivity; report success only after the operation is confirmed. A loading state or failed read must not appear as an empty result.

### 2. Match between the system and the real world

Use familiar task language and natural ordering. A desktop tool, checkout and mobile form should describe what the user can do, without requiring knowledge of internal implementation names.

### 3. User control and freedom

Provide predictable cancel, back and undo where supported. Preserve drafts and selections. Ask before risky changes, restore the previous state after cancellation and keep permissions opt-in and revocable.

### 4. Consistency and standards

Reuse the product's components, labels, spacing and interaction patterns. Respect host-platform keyboard, navigation and dialog conventions so the same action behaves consistently across views.

### 5. Error prevention

Constrain invalid choices before submission, explain prerequisites and separate destructive actions. Keep validation authoritative and preserve security checks even when simplifying a form or toolbar.

### 6. Recognition rather than recall

Keep choices and context discoverable. Prefer readable labels for ambiguous actions; never turn a header into a row of indecipherable icons. Familiar icons may support concise text; tooltips supplement recognition rather than replacing it.

### 7. Flexibility and efficiency of use

Support keyboard operation, sensible defaults and shortcuts without hiding the ordinary path. Adapt density to the viewport and user task; advanced options should not obstruct common actions.

### 8. Aesthetic and minimalist design

Create one clear hierarchy and remove redundant chrome. Keep critical state and actions visible. Minimalism should reduce cognitive effort, not transfer interpretation to the user or remove needed capabilities.

### 9. Help users recognize, diagnose, and recover from errors

Explain the failure in plain language and offer a safe correction or retry. Retain valid input, distinguish partial success from completion and avoid exposing secrets in error messages.

### 10. Help and documentation

Place concise, task-specific guidance near unfamiliar controls and link deeper help when needed. Explain permissions, limits and consequences before the user must decide; avoid permanent walls of instructional text.

## Accessibility across platforms

Target WCAG 2.2 AA where applicable and equivalent native accessibility behavior. Verify text and control contrast, keyboard access, visible focus, reading order, semantic names and states, screen-reader announcements, text scaling, 200% zoom and reflow. Respect `prefers-reduced-motion`; animation, haptics and sound are never the sole signal.

Never use color alone for status: pair it with visible text, a distinct symbol or another visible shape, plus an accessible description. An ARIA label or tooltip alone is not the visible alternative required by [WCAG use of color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html). Preserve labels when an icon is ambiguous, including in narrow layouts.

## Mobile and touch guidance, when applicable

For mobile or touch interfaces, complement the general heuristics with reachable primary actions, thumb zones, safe-area and virtual-keyboard handling, comfortable spacing and appropriate input keyboards. Recommend 48x48 logical-pixel touch targets; this is a mobile comfort recommendation, not a universal WCAG AA minimum. [WCAG 2.2 AA target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) uses 24x24 CSS pixels with defined exceptions. Test the product's supported narrow widths and orientation changes without clipped controls or horizontal overflow.

## Delivery gate

Record concise evidence for the affected heuristics and accessibility checks in the existing project checklist or PR description, and run tests by impact. Physical-device, screen-reader and real-user checks not actually performed are `PENDING_OWNER_VALIDATION`, never a synthetic PASS. Automated checks do not certify the whole interface or future design decisions.

This skill guides design and review only: it never grants permissions or bypasses IDE controls.
