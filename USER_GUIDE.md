# QGH Simulator User Guide

Web version 4.4.2 · Numeric Callsigns

QGH Simulator is an offline-first training aid for practising controller-led QGH procedures. It includes Single Aircraft QGH (Normal and U/S Compass) and Tactical QGH for two to four aircraft.

It is not an operational air-traffic-control system and must not be used for live aviation decisions.

## Start an exercise

On first opening, the simulator offers an optional **Guided Familiarisation**. It introduces live controller RT calls in a short Single Aircraft or Tactical tour without changing any exercise behaviour. It deliberately focuses on the exercise console rather than setup or review voice commands. Select **Skip** if you already know the training environment; select **Guided Tour** in the header later to reopen it.

1. Open **Single Aircraft QGH** or **Tactical QGH**.
2. Enter the runway orientation, inbound/final track, and outbound track.
3. Select the aircraft profile, speed, rate of turn, and procedure.
4. Select **Start Simulator**.

Every exercise begins from a new random aircraft position and flight state.

## Single Aircraft QGH

### Normal QGH

Use **Transmit for D/F** to display the live QDM or QTE only during a transmission. Use the heading field with **Turn Left** or **Turn Right** to issue a heading assignment. The aircraft turns at the configured rate and follows a curved path at its current speed.

Use **Report Heading**, **Request Distance**, and the exercise clock when required. **Advance Flight · 1 Min** advances the aircraft through one minute of real flight physics without changing the controller stopwatch.

### U/S Compass

Use only **Turn Left Now**, **Turn Right Now**, and **Stop Turn Now** for turns. Heading assignments are intentionally not available in this procedure.

## Tactical QGH

Choose two, three, or four aircraft. The simulator assigns levels separated by 1,000 ft unless you set them yourself. Select an aircraft from the left rail before transmitting or issuing an instruction.

When formation flight is enabled, wingmen follow the nominated leader until **Stop Following Leader** is selected for an individual aircraft. That aircraft then continues on its last assigned heading and can be recovered independently.

## Exercise clock and review

The exercise clock has Start, Stop, and Reset controls. It records controller timing separately from aircraft movement.

Select **Terminate Exercise** when the exercise is complete, then confirm the existing termination prompt. The review page shows the flown path, reference radials, command log, overhead/base-turn analysis, replay marker, and replay-speed choices. Use replay, zoom, fit, and return-to-console controls as required.

## Voice control

Voice control is an additional way to operate the simulator. It does not replace the visible controls. The primary voice flow is the live exercise: direction finding, turns, timing and aircraft-specific tactical instructions.

- **PTT** is the default. Hold **PTT**, say one complete command, then release it.
- Open **VOICE** for setup and listening choices. On first use, select **SET UP OFFLINE VOICE** and wait until the ready state appears.
- **Continuous Listening** is optional. Turn it on only in a quiet environment. It opens a compact voice-assistant state with a clear **Stop** action.
- A clear recognised exercise instruction is executed immediately. An unclear, incomplete, hidden, or disabled command makes no change to the exercise.
- The simulator requests microphone access only when you start voice control. It does not use a cloud speech fallback.

Voice recognition uses the bundled Vosk offline engine. The browser-installed PWA downloads its self-hosted model once during the user-selected setup step (about 40 MB), then keeps it in local browser storage for offline use. Windows and Android include the same model with the app; Android prepares it locally on first use and does not require an Android speech service or language pack. It never falls back to cloud recognition. If voice setup is unavailable or fails, use the normal controls; simulator operation remains offline and unchanged.

### Speak heading digits clearly

Speak headings digit by digit. Aviation pronunciations are accepted:

- `zero`, `one`, `two`, `tree`, `four`, `fife`, `six`, `seven`, `eight`, `niner`
- Example: **“Turn right heading two seven zero.”**
- Example: **“Turn left heading zero niner zero.”**

### Exercise RT calls

Single Aircraft Normal QGH:

- “Transmit for D F.”
- “Show QDM.” or “Show QTE.”
- “Turn right heading zero six zero.”
- “Turn left heading two seven zero.”
- “Continue zero six zero.” **Only while a same-direction turn is already active.** If no matching turn is underway, issue a full left or right heading call.
- “Report heading.”
- “Request distance.”
- “Start clock.”, “Stop clock.”, or “Reset clock.”
- “Advance flight one minute.”

U/S Compass:

- “Turn left now.”
- “Turn right now.”
- “Stop turn now.”

Tactical QGH:

- Begin every call with the exact visible callsign. A unique designator such as Raven is accepted, but use the full callsign if two aircraft share it.
- Standalone numeric callsigns from **100 to 999** are accepted. For callsign **387**, say **TREE EIGHT SEVEN** before the instruction.
- “Raven Twenty One turn right heading zero six zero.”
- “Raven Twenty One continue zero six zero.” **Only while Raven Twenty One is already turning in that direction.**
- “Raven Twenty One transmit for D/F.”
- “Raven Twenty One turn right now.” or “Raven Twenty One stop turn now.”
- “Raven Twenty One stop following leader.”

For a custom callsign, replace `Raven Twenty One` with the complete callsign currently visible on screen. The accepted form is **complete callsign · action · required target**. Say one action at a time; if a callsign is not recognised, select it normally.

The visible setup and review controls remain available. They are intentionally not part of the initial voice demonstration, so a new controller learns the real-time exercise flow first.

## Voice-control troubleshooting

### Optional pilot replies through headphones

Pilot sound starts **muted on every page**, regardless of an earlier visit. The web app includes four male pilot voices with the initial offline download; it does not substitute a phone's installed voice. The target pace is approximately 100 words per minute on both laptops and phones. Single aircraft uses Michael; tactical aircraft A–D use Michael, Fenrir, Puck and George. Unfamiliar callsigns may be spelled.

1. Connect and wear headphones. Speaker audio can enter your microphone and cause unintended controller commands.
2. Open **VOICE → HEADPHONES · PILOT READBACKS**.
3. Select **TEST HEADPHONE AUDIO**, listen, then confirm that you heard the test through your headphones.
4. Choose **ENABLE PILOT REPLIES**. Use **MUTE PILOT REPLIES** before removing or disconnecting headphones.

The confirmation is **not automatic headphone detection**. A reported audio-device change mutes speech and requires another test, but browsers do not reliably report every output-route change. Hiding the page also mutes speech. During the headphone test, recognition is temporarily blocked; aircraft continue flying.

PTT interrupts a pilot reply immediately. In Continuous Listening, detected controller speech cancels the old reply; a newly accepted instruction executes immediately and receives a fresh reply. The old reply is discarded. A manoeuvre never waits for speech, and manual controls remain usable. Muting speech does not remove red feedback or transmission-linked aircraft D/F, including the two-second indication hold after release.

Wait for the initial pilot-pack download to finish while online before relying on offline pilot speech. Controller recognition still has its separate **SET UP OFFLINE VOICE** step. Cleared browser storage requires another download. The complete current guide, including orbits and passing-heading reports, is available inside **USER GUIDE** in the simulator.

### If recognition does not respond

- Allow microphone access when asked.
- Use a quiet room or headset microphone.
- Give one command at a time; do not combine two actions in one sentence.
- Say heading digits individually.
- In Continuous Listening mode, pause briefly between commands.
- If the browser PWA shows **SET UP OFFLINE VOICE**, connect once, select it, and wait for preparation to finish before using airplane mode. If it shows an unavailable or failed state, use the standard controls. No flight state is lost.
- On Android, allow microphone access when requested and allow the bundled model's first preparation to complete. No Android speech service or language pack is required.

## Offline use

Previously released Windows and Android applications contain the simulator and recognition model locally; this 4.4.2 release updates the web app only. The web edition works offline after its first successful load; recognition also needs its one-time, user-selected offline-model setup, and spoken pilot replies need the initial pilot-pack download to complete. No controller voice recording is sent to a QGH Simulator server or to a cloud speech service.

## Support and licence

Copyright (c) 2026 Flt Lt Balaram Reddy, Service No. 38703. QGH Simulator code is available under the MIT License; bundled third-party voices and dependencies retain their own notices. [Open Reds QGH Simulator](https://reds-aviation.github.io/qgh-voice/) or visit the [source repository](https://github.com/reds-aviation/qgh-voice).
