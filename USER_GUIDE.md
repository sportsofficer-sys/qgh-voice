# QGH Simulator User Guide

Version 4.1.0

QGH Simulator is an offline-first training aid for practising controller-led QGH procedures. It includes Single Aircraft QGH (Normal and U/S Compass) and Tactical QGH for two to four aircraft.

It is not an operational air-traffic-control system and must not be used for live aviation decisions.

## Start an exercise

On first opening, the simulator offers an optional **Guided Familiarisation**. It introduces the real controls in a short Single Aircraft or Tactical tour without changing any exercise behaviour. Select **Skip** if you already know the training environment; select **Guided Tour** in the header later to reopen it.

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

Voice control is an additional way to operate the simulator. It does not replace the visible controls.

- **PTT** is the default. Hold **PTT**, say one complete command, then release it.
- Open **VOICE** for setup and listening choices. On first use, select **SET UP OFFLINE VOICE** and wait until the ready state appears.
- **Continuous Listening** is optional. Turn it on only in a quiet environment. It opens a compact voice-assistant state with a clear **Stop** action.
- An exact recognised instruction is executed immediately. An unclear, incomplete, hidden, or disabled command makes no change to the exercise.
- The simulator requests microphone access only when you start voice control. It does not use a cloud speech fallback.

Voice recognition uses the bundled Vosk offline engine. The browser-installed PWA downloads its self-hosted model once during the user-selected setup step (about 40 MB), then keeps it in local browser storage for offline use. Windows and Android include the same model with the app; Android prepares it locally on first use and does not require an Android speech service or language pack. It never falls back to cloud recognition. If voice setup is unavailable or fails, use the normal controls; simulator operation remains offline and unchanged.

### Speak heading digits clearly

Speak headings digit by digit. Aviation pronunciations are accepted:

- `zero`, `one`, `two`, `tree`, `four`, `fife`, `six`, `seven`, `eight`, `niner`
- Example: **“Turn right heading two seven zero.”**
- Example: **“Turn left heading zero niner zero.”**

### Common commands

Single Aircraft Normal QGH:

- “Set runway two three zero.”
- “Set inbound track two two five.”
- “Set outbound track zero six five.”
- “Select aircraft profile Rafale.”
- “Normal QGH.” or “U S Compass.”
- “Start simulator.”
- “Transmit for D F.”
- “Show QDM.” or “Show QTE.”
- “Turn left heading two seven zero.”
- “Turn right heading one eight zero.”
- “Report heading.”
- “Request distance.”
- “Set speed two four zero.”
- “Start clock.”, “Stop clock.”, or “Reset clock.”
- “Advance flight one minute.”
- “Restart exercise.”
- “Terminate exercise.” followed by “Confirm termination.”

U/S Compass:

- “Turn left now.”
- “Turn right now.”
- “Stop turn now.”

Review:

- “Replay track.”, “Pause replay.”, or “Resume replay.”
- “Set replay speed three times.”
- “Enable zoom.”, “Disable zoom.”, or “Fit track.”
- “Return to console.”
- “New exercise.”

Tactical QGH:

- “Select aircraft Falcon Eleven.”
- “Transmit for D/F Falcon Eleven.”
- “Falcon Eleven turn right heading two seven zero.”
- “Formation on.” or “Formation off.”
- “Stop following leader.”
- “Focus all aircraft.”

For a custom callsign, speak one action at a time and use the exact callsign currently visible on screen. If it is not recognised, select or type the callsign normally.

## Voice-control troubleshooting

- Allow microphone access when asked.
- Use a quiet room or headset microphone.
- Give one command at a time; do not combine two actions in one sentence.
- Say heading digits individually.
- In Continuous Listening mode, pause briefly between commands.
- If the browser PWA shows **SET UP OFFLINE VOICE**, connect once, select it, and wait for preparation to finish before using airplane mode. If it shows an unavailable or failed state, use the standard controls. No flight state is lost.
- On Android, allow microphone access when requested and allow the bundled model's first preparation to complete. No Android speech service or language pack is required.

## Offline use

The Windows and Android applications contain the simulator and voice model locally. The web edition works offline after its first successful load; its voice feature also needs the one-time, user-selected offline-model setup while online. No controller voice recording is sent to a QGH Simulator server or to a cloud speech service.

## Support and licence

Copyright (c) 2026 Flt Lt Balaram Reddy, Service No. 38703. QGH Simulator is available under the MIT License. For source, updates, and support material, see the project repository.
