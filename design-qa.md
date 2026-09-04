# Voice Rail Design QA — v4.2.1

## Comparison target

- **Source visual truth:** `C:\Users\pc\.codex\generated_images\01a02f24-5131-7bd1-97e2-7eb79662c04c\exec-cfdd1737-a7ef-4aee-a4b8-a54ddcc1cc06.png` (1487 × 1058 px). The selected target is its right-edge voice rail only. The user explicitly required the live exercise window itself to remain unchanged, so the source mock's other layout regions are out of scope.
- **Implementation capture:** Codex In-app Browser capture, tab 16, `http://127.0.0.1:4209/single.html`, 1264 × 708 px browser-content capture, desktop state, local voice not yet set up.
- **Normalization:** The comparison is limited to the rail component and its clearance from the exercise UI; full-page pixel matching is intentionally not applicable because the existing exercise UI is a protected surface.

## Evidence and checks

- Full-view evidence confirms the Single QGH setup card remains unchanged and the 68 px teal voice rail sits in the right gutter rather than over a simulator control.
- Focused region evidence confirms a vertical teal rail, clear `PTT`, `VOICE`, move affordance, compact readiness state, and a settings panel that appears only after the user requests it.
- Keyboard PTT, pointer PTT, continuous listening, D/F routing, empty-result feedback, movable position persistence, and manual-control fallback are covered by the local test suite.

## Findings

- **[P1 — fixed] Voice setup opened automatically and covered the live view.** The setup card now stays closed until `VOICE` is selected.
- **[P1 — fixed] Recognition feedback could expand across the exercise interface.** Feedback is now a two-line, time-limited status inside the edge rail; full wording remains available to assistive technology and as the control title.
- **[P2 — fixed] Continuous mode opened a second floating assistant panel.** Continuous state is now represented within the rail, while its existing manual stop/toggle behavior remains available.
- **[P2 — fixed] Previous large-dock positions could carry forward into the new rail.** The saved position key was advanced to a new generation.

## Fidelity surfaces

- **Fonts and typography:** Existing IBM Plex Sans / Mono hierarchy is retained; rail labels are compact but readable, with accessible names on every control.
- **Spacing and layout rhythm:** The rail is narrow, rounded, edge-aligned, and outside the protected exercise layout. Settings and destructive-command confirmation open only on deliberate interaction.
- **Colors and visual tokens:** The existing QGH teal, ivory, navy, and status colors are retained with high contrast.
- **Image and asset fidelity:** The selected voice-rail concept requires no new product image asset. Existing application identity assets remain unchanged.
- **Copy and content:** `PTT`, `VOICE`, `MOVE`, readiness, listening, and short acceptance messages are intentionally terse to avoid obstructing controller work.

## Implementation checklist

- [x] Preserve the existing Normal and U/S exercise windows.
- [x] Add a compact movable edge voice rail.
- [x] Keep PTT and continuous mode accessible.
- [x] Keep manual simulator controls independent of voice status.
- [x] Prevent setup/feedback overlays from opening automatically over the exercise view.

## Follow-up polish

- [P3] Confirm the preferred default rail position on a physical phone after installation; the rail remains movable and respects safe-area insets.

final result: passed
