import { Suspense, lazy, type ReactNode } from "react"
import { BrowserRouter as Router, Navigate, Routes, Route } from "react-router-dom"
import { ThemeProvider } from "./components/ui/theme-provider"
import { Toaster } from "./components/ui/toaster"
import { AuthProvider } from "./contexts/AuthContext"
import { ProtectedRoute } from "./components/ProtectedRoute"
import { Layout } from "./components/Layout"

const Login = lazy(() => import("./pages/Login").then((module) => ({ default: module.Login })))
const Register = lazy(() => import("./pages/Register").then((module) => ({ default: module.Register })))
const BlankPage = lazy(() => import("./pages/BlankPage").then((module) => ({ default: module.BlankPage })))
const Dashboard = lazy(() => import("./pages/Dashboard").then((module) => ({ default: module.Dashboard })))
const Weather = lazy(() => import("./pages/Weather"))
const DataPlatform = lazy(() => import("./pages/DataPlatform"))
const Devices = lazy(() => import("./pages/Devices").then((module) => ({ default: module.Devices })))
const DeviceGroups = lazy(() => import("./pages/DeviceGroups").then((module) => ({ default: module.DeviceGroups })))
const Scenes = lazy(() => import("./pages/Scenes").then((module) => ({ default: module.Scenes })))
const Workflows = lazy(() => import("./pages/Workflows").then((module) => ({ default: module.Workflows })))
const VoiceDevices = lazy(() => import("./pages/VoiceDevices").then((module) => ({ default: module.VoiceDevices })))
const UserProfiles = lazy(() => import("./pages/UserProfiles").then((module) => ({ default: module.UserProfiles })))
const Users = lazy(() => import("./pages/Users").then((module) => ({ default: module.Users })))
const Settings = lazy(() => import("./pages/Settings").then((module) => ({ default: module.Settings })))
const PlatformDeploy = lazy(() => import("./pages/PlatformDeploy").then((module) => ({ default: module.PlatformDeploy })))
const ReverseProxyManagement = lazy(() => import("./pages/ReverseProxyManagement"))
const Operations = lazy(() => import("./pages/Operations").then((module) => ({ default: module.Operations })))
const SSLManagement = lazy(() => import("./pages/SSLManagement"))
const AlexaBrokerManagement = lazy(() => import("./pages/AlexaBrokerManagement"))
const OllamaManagement = lazy(() => import("./pages/OllamaManagement"))
const WhisperManagement = lazy(() => import("./pages/WhisperManagement"))

function LoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center px-6">
      <div className="glass-panel glass-panel-strong rounded-[2rem] px-8 py-7 text-center">
        <div className="mx-auto h-12 w-12 animate-spin rounded-full border-2 border-white/20 border-t-cyan-400" />
        <p className="mt-4 section-kicker">Initializing HomeBrain</p>
        <p className="mt-2 text-sm text-muted-foreground">Warming up the command deck.</p>
      </div>
    </div>
  )
}

const withLayout = (content: ReactNode, options: { adminOnly?: boolean } = {}) => (
  <ProtectedRoute adminOnly={options.adminOnly}>
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
            <Route path="/weather" element={withLayout(<Weather />)} />
            <Route path="/data-platform" element={withLayout(<DataPlatform />)} />
            <Route path="/devices" element={withLayout(<Devices />)} />
            <Route path="/device-groups" element={withLayout(<DeviceGroups />, { adminOnly: true })} />
            <Route path="/scenes" element={withLayout(<Scenes />)} />
            <Route path="/workflows" element={withLayout(<Workflows />)} />
            <Route path="/automations" element={<Navigate to="/workflows" replace />} />
            <Route path="/voice-devices" element={withLayout(<VoiceDevices />, { adminOnly: true })} />
            <Route path="/voice-profiles" element={withLayout(<UserProfiles />)} />
            <Route path="/profiles" element={withLayout(<UserProfiles />)} />
            <Route path="/users" element={withLayout(<Users />, { adminOnly: true })} />
            <Route path="/settings" element={withLayout(<Settings />, { adminOnly: true })} />
            <Route path="/alexa-broker" element={withLayout(<AlexaBrokerManagement />, { adminOnly: true })} />
            <Route path="/platform-deploy" element={withLayout(<PlatformDeploy />, { adminOnly: true })} />
            <Route path="/reverse-proxy" element={withLayout(<ReverseProxyManagement />, { adminOnly: true })} />
            <Route path="/operations" element={withLayout(<Operations />, { adminOnly: true })} />
            <Route path="/ssl" element={withLayout(<SSLManagement />, { adminOnly: true })} />
            <Route path="/ollama" element={withLayout(<OllamaManagement />, { adminOnly: true })} />
            <Route path="/whisper" element={withLayout(<WhisperManagement />, { adminOnly: true })} />
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
