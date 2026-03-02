# ISY Program Capability Matrix (HomeBrain Import)

Last updated: 2026-03-02

Official references used:
- https://wiki.universal-devices.com/ISY-99i/ISY-26_INSTEON:Program_Commands
- https://wiki.universal-devices.com/ISY-99i/ISY-26_INSTEON:Variable_Details
- https://wiki.universal-devices.com/ISY-99i/ISY-26_INSTEON:Scope,_Precedence_and_Execution_Order
- https://wiki.universal-devices.com/ISY_Developers:API:REST_Interface

## Condition/IF Coverage

| ISY capability | HomeBrain import status | Notes |
| --- | --- | --- |
| `And` / `Or` expression logic | Supported | Parser uses precedence (`And` > `Or`) and supports parenthesis tokens. |
| `Time is HH:MM` | Supported | Imported as IF expression evaluated on scheduler edge-change polling. |
| `From ... To ...` (clock-time windows) | Supported | Imported as `time_window` expression. |
| `From ... For ...` (clock-time + duration) | Supported | Converted to `time_window` expression. |
| `On Mon..Sun` day restrictions | Supported | Days are attached to schedule/time expressions. |
| `Status 'node' ...` | Supported | Imported as `device_state` expression. |
| `Control 'node' ...` | Supported (state-oriented) | Imported to device-state expression model for workflow execution. |
| `Program 'X' is True/False` | Supported | Imported as `isy_program_state` expression. |
| Variable comparisons (`$x is`, `>`, `<`, etc.) | Supported | Imported as `isy_variable` expression. |

## Action/THEN/ELSE Coverage

| ISY capability | HomeBrain import status | Notes |
| --- | --- | --- |
| `Set 'Device' On/Off/%` | Supported | Translated to `device_control` actions. |
| `Set Scene 'X' On/Off` | Supported | On => scene activation; Off => derived per-device off actions. |
| `Wait` (+ Random) | Supported | Translated to `delay` with optional randomization. |
| `Repeat For ... Times` (+ Random) | Supported | Translated to executable `repeat` action with nested block actions. |
| `Repeat Every ...` | Supported | Translated to `repeat` mode `every` with continue-while condition semantics. |
| Variable math (`=`, `+=`, `-=`, `*=`, `/=`, `%=` and bitwise) | Supported | Translated to executable `variable_control` actions. |
| `Init To` variable initialization | Supported | Translated to `variable_control` init operation. |
| `Run Program` (`If`, `Then Path`, `Else Path`) | Supported | Translated to executable `workflow_control` actions targeting imported workflows. |
| `Stop/Enable/Disable Program` | Supported | Translated to `workflow_control` operations. |
| `Set Program ... Run At Startup` | Supported | Translated to `workflow_control` startup-state operations. |
| `Send Notification` | Supported | Translated to `notification` action. |
| `Network Resource` / `Resource` actions | Supported | HTTP/HTTPS resources are translated into native `http_request` workflow actions. Other resource protocols execute via `isy_network_resource` passthrough using ISY REST (`/rest/networking/resources/<id>`). |

## Runtime Semantics

| ISY behavior | HomeBrain import/runtime status |
| --- | --- |
| IF/THEN/ELSE branch execution | Supported via single-workflow condition action with `onFalseActions` (ELSE) and edge-change evaluation. |
| Condition edge-change behavior | Supported (`change`, `rising`, `falling`) in workflow condition execution. |
| Program-to-program calls | Supported by translated `workflow_control` actions and recursive execution limits. |
| Repeat block execution | Supported with nested action execution and guard rails (`maxIterations`, recursion depth limits). |

## Known Gaps

- Non-HTTP network-resource protocols (for example TCP/UDP styles configured in ISY) currently execute through ISY passthrough and still require valid ISY connectivity/credentials at runtime.
- Any line not recognized by parser is preserved as an explicit notification step so migration stays lossless and auditable.
