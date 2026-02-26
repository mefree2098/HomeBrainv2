# HomeBrain User Guide

This guide is for household users who only need to use the system, not administer it.

## Basic Voice Use

1. Say your wake word (for example, `Anna` or `Henry`).
2. Wait for the short acknowledgment tone/line.
3. Speak your command naturally.

Examples:
- "Anna, turn on the kitchen lights."
- "Henry, set movie night scene."
- "Anna, start the living room movie activity on Harmony Hub."
- "Anna, what devices are still on?"
- "Anna, run bedtime workflow."
- "Henry, disable vacation workflow."

## Workflows You Can Ask For

If your admin created workflows, you can control them by voice:
- `run <workflow name>`
- `enable <workflow name>`
- `disable <workflow name>`

You can also ask HomeBrain to create one in chat/command UI:
- "create a workflow that locks doors at 10 PM"
- "create a workflow that starts the family room TV activity at 7 PM"

## What to Expect

After wake word detection:
1. HomeBrain plays a quick acknowledgment phrase.
2. HomeBrain processes your request.
3. HomeBrain answers with a full voice response.

## If Voice Seems Slow

Tell your admin to check:
- `Voice Devices` online status
- STT provider health (`Whisper STT` page if local mode)
- Internet/API key status (if cloud STT/TTS is used)

## If Voice Does Not Trigger

Try:
1. Speak closer to the room listener.
2. Reduce background noise.
3. Use the exact configured wake phrase.
4. Ask your admin to verify wake word model status is `ready`.

## Privacy Basics

HomeBrain supports local-first operation:
- Wake-word detection runs on listener devices.
- STT can run on the Jetson hub (Whisper local mode).
- Device control remains on your local network.

Your admin can still enable cloud providers (for example OpenAI or ElevenLabs) if desired.
