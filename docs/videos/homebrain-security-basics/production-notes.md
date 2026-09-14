# HomeBrain Security Basics

This tutorial uses HomeBrain's built-in UI preview mode on the iPad Simulator. The footage is a real capture of the application and its controls, but the preview data prevents the recording from changing a connected home's alarm state or exposing household-specific information.

Topics covered:

- Arm Away: for an empty home; monitors sensors configured for Away, including interior motion when enabled.
- Arm Stay: for an occupied home; protects configured perimeter sensors while typically excluding interior motion.
- Disarm: turns armed monitoring off; a security PIN may be required by the home's configuration.

The final video should be 1920 by 1080, H.264/AAC, with narration, a low instrumental bed, on-screen section labels, tap indicators, and burned-in captions.

## Narration direction

Use the ElevenLabs `Evening British Female` voice through the API with model `eleven_v3`. The approved script is `narration-v3-calm-tagged.txt`, which applies `[calm, measured, and matter-of-fact]` to every section. The approved source is `sources/audio/narration-evening-british-female-v3-calm.mp3`; `narration-evening-british-female-v3-calm-timed.wav` preserves the tutorial cue timing without changing pitch. API settings: natural stability `0.5`, similarity `0.75`, style `0`, speed `0.96`, and speaker boost disabled.
