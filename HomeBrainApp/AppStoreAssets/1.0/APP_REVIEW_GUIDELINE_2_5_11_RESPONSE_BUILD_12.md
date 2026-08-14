# HomeBrain App Review response — Guideline 2.5.11(i)

Prepared August 14, 2026 for HomeBrain **1.0 (build 12)** in response to the August 12 review of build 11.

## Root cause and correction

Build 11 contained an unused App Intents declaration named **Open HomeBrain**. Its only behavior was to launch the app; HomeBrain did not present or depend on that shortcut in its user interface. This created App Intents metadata that did not represent a substantive HomeBrain action and caused the reviewer to find an Intents integration they could not locate in the app.

Build 12 removes that integration completely:

- no type conforms to `AppIntent` or `AppShortcutsProvider`;
- neither the iPhone app nor Apple Watch app imports `AppIntents`;
- there is no Siri entitlement;
- there is no Intents or Intents UI extension; and
- the archived application contains no registered HomeBrain intent or shortcut.

The removal does not affect HomeBrain's in-app voice console. That optional feature uses the microphone and Apple Speech Recognition inside HomeBrain after the user explicitly opens the voice console; it does not register SiriKit or Shortcuts intents.

## Required App Store Connect configuration

Select **version 1.0, build 12** for the new submission. Do not resubmit build 11.

Keep **Sign-in required** set to **Yes** and retain the existing persistent App Review credential. The reviewer username automatically selects the public review sandbox; no Siri, Shortcuts, additional app, accessory, VPN, or private network is required.

## Paste-ready Resolution Center reply

```text
Hello App Review,

Thank you for identifying the App Intents issue. We found and removed the unused integration in version 1.0, build 12.

Build 11 contained one App Intent named “Open HomeBrain.” It only launched the app and was not presented as a substantive feature in HomeBrain, which explains why the reviewer could not locate an Intents feature in the app.

Build 12 removes the App Intents and Shortcuts integration completely. The iPhone and Apple Watch applications no longer import AppIntents, the app declares no AppIntent or AppShortcutsProvider types, there is no Siri entitlement, and there is no Intents or Intents UI extension. No HomeBrain intent or shortcut is registered in the submitted archive.

HomeBrain's optional in-app voice console remains an ordinary in-app feature. It uses the microphone and Apple Speech Recognition only after the user opens the voice console; it does not use SiriKit, Siri, Shortcuts, or an additional app.

Please review version 1.0, build 12—not build 11. The existing App Review credentials open the isolated public demo home, and no Siri configuration, Shortcuts setup, additional app, physical accessory, VPN, or private network is required.

Thank you.
```
