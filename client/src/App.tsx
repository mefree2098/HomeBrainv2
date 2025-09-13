import { BrowserRouter as Router, Routes, Route } from "react-router-dom"
import { ThemeProvider } from "./components/ui/theme-provider"
import { Toaster } from "./components/ui/toaster"
import { AuthProvider } from "./contexts/AuthContext"
import { Login } from "./pages/Login"
import { Register } from "./pages/Register"
import { ProtectedRoute } from "./components/ProtectedRoute"
import { Layout } from "./components/Layout"
import { BlankPage } from "./pages/BlankPage"
import { Dashboard } from "./pages/Dashboard"
import { Devices } from "./pages/Devices"
import { Scenes } from "./pages/Scenes"
import { Automations } from "./pages/Automations"
import { VoiceDevices } from "./pages/VoiceDevices"
import { UserProfiles } from "./pages/UserProfiles"
import { Settings } from "./pages/Settings"

function App() {
  return (
  <AuthProvider>
    <ThemeProvider defaultTheme="light" storageKey="ui-theme">
      <Router>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/" element={<ProtectedRoute><Layout><Dashboard /></Layout></ProtectedRoute>} />
          <Route path="/devices" element={<ProtectedRoute><Layout><Devices /></Layout></ProtectedRoute>} />
          <Route path="/scenes" element={<ProtectedRoute><Layout><Scenes /></Layout></ProtectedRoute>} />
          <Route path="/automations" element={<ProtectedRoute><Layout><Automations /></Layout></ProtectedRoute>} />
          <Route path="/voice-devices" element={<ProtectedRoute><Layout><VoiceDevices /></Layout></ProtectedRoute>} />
          <Route path="/profiles" element={<ProtectedRoute><Layout><UserProfiles /></Layout></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><Layout><Settings /></Layout></ProtectedRoute>} />
          <Route path="*" element={<BlankPage />} />
        </Routes>
      </Router>
      <Toaster />
    </ThemeProvider>
  </AuthProvider>
  )
}

export default App