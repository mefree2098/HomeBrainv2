import { useState } from "react"
import { useForm } from "react-hook-form"
import { useLocation, useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from "@/components/ui/card"
import { useToast } from "@/hooks/useToast"
import {
  LogIn
} from "lucide-react"
import { useAuth } from "@/contexts/AuthContext"
import { ThemeToggle } from "@/components/ui/theme-toggle"

type LoginForm = {
  email: string
  password: string
}

export function Login() {
  const [loading, setLoading] = useState(false)
  const { toast } = useToast()
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const { register, handleSubmit } = useForm<LoginForm>()
  const returnTo = (() => {
    const raw = new URLSearchParams(location.search).get("returnTo")
    if (!raw) {
      return ""
    }

    try {
      const parsed = new URL(raw, window.location.origin)
      if (parsed.origin !== window.location.origin) {
        return ""
      }
      return `${parsed.pathname}${parsed.search}${parsed.hash}`
    } catch (_error) {
      return ""
    }
  })()

  const onSubmit = async (data: LoginForm) => {
    try {
      setLoading(true)
      await login(data.email, data.password);
      toast({
        title: "Success",
        description: "Logged in successfully",
      })
      if (returnTo) {
        window.location.assign(returnTo)
        return
      }
      navigate("/")
    } catch (error) {
      console.error("Login error:", error.message)
      toast({
        variant: "destructive",
        title: "Error",
        description: error?.message,
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden px-4 py-6 sm:px-6 lg:px-8">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="drift-slow absolute left-[-10rem] top-[8rem] h-[24rem] w-[24rem] rounded-full bg-cyan-300/30 blur-3xl dark:bg-cyan-500/18" />
        <div className="float-slow absolute right-[-8rem] top-[12rem] h-[20rem] w-[20rem] rounded-full bg-blue-300/20 blur-3xl dark:bg-blue-500/16" />
      </div>

      <div className="relative mx-auto grid min-h-[calc(100vh-3rem)] max-w-6xl items-center gap-6 lg:grid-cols-[1.05fr_0.95fr]">
        <section className="glass-panel glass-panel-strong rounded-[2rem] p-8 lg:p-10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="relative flex h-12 w-12 items-center justify-center rounded-[1.1rem] bg-gradient-to-br from-cyan-300/70 via-sky-300/55 to-blue-500/70 shadow-lg shadow-sky-400/20">
                <div className="absolute inset-[1px] rounded-[calc(1.1rem-1px)] bg-white/70 dark:bg-slate-950/35" />
                <img src="/homebrain-brand-64.png" alt="HomeBrain" className="relative h-7 w-7 rounded object-cover" />
              </div>
              <div>
                <p className="section-kicker">HomeBrain OS</p>
                <p className="text-base font-semibold text-foreground">Cinematic Command Deck</p>
              </div>
            </div>
            <ThemeToggle />
          </div>

          <div className="mt-10 max-w-2xl">
            <p className="section-kicker">Access Portal</p>
            <h1 className="mt-3 text-balance text-4xl font-semibold leading-tight text-foreground sm:text-5xl">
              <span className="text-signal">Step into the house-wide control deck.</span>
            </h1>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground">
              Monitor every room, launch scenes, and orchestrate your home through a polished light and dark
              interface built for instant control.
            </p>
          </div>

          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            <div className="card-shell rounded-[1.3rem] p-4">
              <p className="section-kicker">Voice</p>
              <p className="mt-2 text-lg font-semibold text-foreground">Wake-word ready</p>
            </div>
            <div className="card-shell rounded-[1.3rem] p-4">
              <p className="section-kicker">Scenes</p>
              <p className="mt-2 text-lg font-semibold text-foreground">Cinematic presets</p>
            </div>
            <div className="card-shell rounded-[1.3rem] p-4">
              <p className="section-kicker">Telemetry</p>
              <p className="mt-2 text-lg font-semibold text-foreground">Live system insight</p>
            </div>
          </div>
        </section>

        <Card className="w-full rounded-[2rem]">
          <CardHeader>
            <p className="section-kicker">Login</p>
            <CardTitle className="mt-2 text-3xl">Welcome back</CardTitle>
            <CardDescription>Enter your credentials to continue into the command deck.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="Enter your email"
                  {...register("email", { required: true })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="Enter your password"
                  {...register("password", { required: true })}
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? (
                  "Loading..."
                ) : (
                  <>
                    <LogIn className="h-4 w-4" />
                    Sign In
                  </>
                )}
              </Button>
            </form>
          </CardContent>
          <CardFooter className="flex justify-center">
            <Button
              variant="link"
              className="text-sm text-muted-foreground"
              onClick={() => navigate(returnTo ? `/register?returnTo=${encodeURIComponent(returnTo)}` : "/register")}
            >
              Don't have an account? Sign up
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
