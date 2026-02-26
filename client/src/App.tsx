import { Suspense, lazy, type ReactNode } from "react"
import { BrowserRouter as Router, Routes, Route } from "react-router-dom"
import { ThemeProvider } from "./components/ui/theme-provider"
import { Toaster } from "./components/ui/toaster"
import { AuthProvider } from "./contexts/AuthContext"
import { ProtectedRoute } from "./components/ProtectedRoute"
import { Layout } from "./components/Layout"

const Login = lazy(() => import("./pages/Login").then((module) => ({ default: module.Login })))
const Register = lazy(() => import("./pages/Register").then((module) => ({ default: module.Register })))
const BlankPage = lazy(() => import("./pages/BlankPage").then((module) => ({ default: module.BlankPage })))
const Dashboard = lazy(() => import("./pages/Dashboard").then((module) => ({ default: module.Dashboard })))
const Devices = lazy(() => import("./pages/Devices").then((module) => ({ default: module.Devices })))
const Scenes = lazy(() => import("./pages/Scenes").then((module) => ({ default: module.Scenes })))
const Automations = lazy(() => import("./pages/Automations").then((module) => ({ default: module.Automations })))
const Workflows = lazy(() => import("./pages/Workflows").then((module) => ({ default: module.Workflows })))
const VoiceDevices = lazy(() => import("./pages/VoiceDevices").then((module) => ({ default: module.VoiceDevices })))
const UserProfiles = lazy(() => import("./pages/UserProfiles").then((module) => ({ default: module.UserProfiles })))
const Settings = lazy(() => import("./pages/Settings").then((module) => ({ default: module.Settings })))
const PlatformDeploy = lazy(() => import("./pages/PlatformDeploy").then((module) => ({ default: module.PlatformDeploy })))
const Operations = lazy(() => import("./pages/Operations").then((module) => ({ default: module.Operations })))
const SSLManagement = lazy(() => import("./pages/SSLManagement"))
const OllamaManagement = lazy(() => import("./pages/OllamaManagement"))
const WhisperManagement = lazy(() => import("./pages/WhisperManagement"))

function LoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
    </div>
  )
}

const withLayout = (content: ReactNode) => (
  <ProtectedRoute>
    <Layout>{content}</Layout>
  </ProtectedRoute>
)

function App() {
  return (
  <AuthProvider>
    <ThemeProvider defaultTheme="system" storageKey="ui-theme">
      <Router>
        <Suspense fallback={<LoadingScreen />}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/" element={withLayout(<Dashboard />)} />
            <Route path="/devices" element={withLayout(<Devices />)} />
            <Route path="/scenes" element={withLayout(<Scenes />)} />
            <Route path="/workflows" element={withLayout(<Workflows />)} />
            <Route path="/automations" element={withLayout(<Automations />)} />
            <Route path="/voice-devices" element={withLayout(<VoiceDevices />)} />
            <Route path="/profiles" element={withLayout(<UserProfiles />)} />
            <Route path="/settings" element={withLayout(<Settings />)} />
            <Route path="/platform-deploy" element={withLayout(<PlatformDeploy />)} />
            <Route path="/operations" element={withLayout(<Operations />)} />
            <Route path="/ssl" element={withLayout(<SSLManagement />)} />
            <Route path="/ollama" element={withLayout(<OllamaManagement />)} />
            <Route path="/whisper" element={withLayout(<WhisperManagement />)} />
            <Route path="*" element={<BlankPage />} />
          </Routes>
        </Suspense>
      </Router>
      <Toaster />
    </ThemeProvider>
  </AuthProvider>
  )
}

export default App
