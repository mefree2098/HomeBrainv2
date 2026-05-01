# HomeBrain Watch App

The watch app is intentionally built as the embedded companion watch target inside
`../HomeBrainApp/HomeBrainApp.xcodeproj`.

Keep the SwiftUI source and watch assets in `HomeBrainWatch Watch App/`, but use
the `HomeBrainApp` scheme for builds, installs, signing, and release work. The
old standalone watch-only Xcode project was removed to avoid producing a second
app bundle with the same watch bundle identifier.
