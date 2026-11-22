---
name: mobile-ux-principles
description: Ten mandatory UX/UI principles for mobile development - simplicity, navigation, one-hand use, speed, touch targets, feedback, accessibility, forms, errors and justified permissions.
---

# Mobile UX/UI - ten mandatory principles

Mandatory for every component, screen, flow, form, pull request and review of mobile UX (React Native, Expo, Flutter, Android, iOS, Capacitor/Ionic, MAUI and mobile web). They complement the project's own UX principles and never replace them. When comfort conflicts with privacy or security, privacy and security prevail. Keep the project's approved branding; do not redesign it.

## The ten principles

1. **Simplicity and visual clarity.** One task hierarchy, priority content first, no saturation, breathing space. Verify 320-390 px widths without overflow.
2. **Intuitive, consistent navigation.** The current route, the way back and every action are unambiguous; visual, iconographic and semantic consistency; correct keyboard and focus; no nested modals.
3. **One-handed use (thumb zone).** The primary action sits where the thumb reaches, center or bottom; destructive actions are separated; validate on a real device.
4. **Fast, fluid performance.** Perceptible response to touch; discreet 200-300 ms transitions only when they help; honor `prefers-reduced-motion`; show real progress.
5. **Comfortable touch interaction.** Touch targets of at least 48x48 logical px with adequate spacing; document any exception against WCAG 2.2 AA.
6. **Immediate visual or haptic feedback.** Pressed state, real loading state, success only after a verifiable protected read, visible error. Haptics and sound are optional, never the only signal.
7. **Accessibility without exceptions.** WCAG 2.2 AA, contrast, 200% zoom, visible focus, reading order, ARIA or native accessibility labels, screen-reader support, scalable font size.
8. **Frictionless forms.** Ask for the minimum; right keyboard type; safe autofill; inline validation; keep drafts; allow manual date entry and month/year.
9. **Clear errors and useful empty states.** Explain the next safe action and how to retry or correct; give guiding initial states; tell a real empty state from a failed read (fail closed).
10. **Justified context, permissions and notifications.** Just-in-time permissions; opt-in and revocable local reminders with no data on the lock screen; never hidden trackers or analytics.

## Delivery gate

Before delivering a change that touches mobile UI, record in the project's checklist (its implementation checklist file if it has one, otherwise the pull request description) the evidence that the ten principles, UX and accessibility hold on the screens touched, and run tests by impact. Anything that needs physical hardware, a screen reader or validation with real users is marked `PENDING_OWNER_VALIDATION`, never a synthetic PASS. Controls that handle sensitive data keep consent, local encryption, session isolation and safe failures.

This skill guides design and review only: it never grants permissions or bypasses IDE controls.
