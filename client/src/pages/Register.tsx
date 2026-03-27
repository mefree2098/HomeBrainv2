import { useEffect, useState } from "react"
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
  UserPlus
} from "lucide-react"
import { useAuth } from "@/contexts/AuthContext"
import { ThemeToggle } from "@/components/ui/theme-toggle"
import { getRegistrationStatus } from "@/api/auth"

type RegisterForm = {
  email: string
  password: string
}

export function Register() {
  const [loading, setLoading] = useState(false)
  const [registrationOpen, setRegistrationOpen] = useState<boolean | null>(null)
  const { toast } = useToast()
  const { register: registerUser } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const { register, handleSubmit } = useForm<RegisterForm>()
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

  useEffect(() => {
    let cancelled = false

    const loadRegistrationStatus = async () => {
      try {
        const status = await getRegistrationStatus()
        if (!cancelled) {
          setRegistrationOpen(status.registrationOpen)
        }
      } catch (_error) {
        if (!cancelled) {
          setRegistrationOpen(false)
        }
      }
    }

    void loadRegistrationStatus()

    return () => {
      cancelled = true
    }
  }, [])

  const onSubmit = async (data: RegisterForm) => {
    try {
      setLoading(true)
      await registerUser(data.email, data.password);
      toast({
        title: "Success",
        description: "Account created successfully",
      })
      navigate(returnTo || "/")
    } catch (error) {
      console.log("Register error:", error)
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
        <div className="drift-slow absolute left-[-9rem] top-[10rem] h-[22rem] w-[22rem] rounded-full bg-cyan-300/30 blur-3xl dark:bg-cyan-500/18" />
        <div className="float-slow absolute right-[-9rem] top-[8rem] h-[22rem] w-[22rem] rounded-full bg-blue-300/22 blur-3xl dark:bg-blue-500/16" />
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
            <p className="section-kicker">Identity Provisioning</p>
            <h1 className="mt-3 text-balance text-4xl font-semibold leading-tight text-foreground sm:text-5xl">
              <span className="text-signal">Create your control identity.</span>
            </h1>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground">
              Join the command deck with a profile that can personalize favorites, shortcuts, and your daily
              orchestration flow.
            </p>
          </div>

          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            <div className="card-shell rounded-[1.3rem] p-4">
              <p className="section-kicker">Profiles</p>
              <p className="mt-2 text-lg font-semibold text-foreground">Adaptive favorites</p>
            </div>
            <div className="card-shell rounded-[1.3rem] p-4">
              <p className="section-kicker">Workflows</p>
              <p className="mt-2 text-lg font-semibold text-foreground">Personal routines</p>
            </div>
            <div className="card-shell rounded-[1.3rem] p-4">
              <p className="section-kicker">Access</p>
              <p className="mt-2 text-lg font-semibold text-foreground">Secure command entry</p>
            </div>
          </div>
        </section>

        <Card className="w-full rounded-[2rem]">
          <CardHeader>
            <p className="section-kicker">Create Account</p>
            <CardTitle className="mt-2 text-3xl">Create an account</CardTitle>
            <CardDescription>
              {registrationOpen === false
                ? "Initial setup is complete. Ask an admin to create your account from the Users page."
                : "Enter your details to get started with HomeBrain."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {registrationOpen === false ? (
              <div className="rounded-[1.5rem] border border-border/70 bg-muted/40 p-4 text-sm text-muted-foreground">
                Public registration is only available before the first HomeBrain admin account is created.
              </div>
            ) : (
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
                    placeholder="Choose a password"
                    {...register("password", { required: true })}
                  />
                </div>
                <Button type="submit" className="w-full" disabled={loading || registrationOpen === null}>
                  {loading ? (
                    "Loading..."
                  ) : (
                    <>
                      <UserPlus className="h-4 w-4" />
                      Create Account
                    </>
                  )}
                </Button>
              </form>
            )}
          </CardContent>
          <CardFooter className="flex justify-center">
            <Button
              variant="link"
              className="text-sm text-muted-foreground"
              onClick={() => navigate(returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : "/login")}
            >
              Already have an account? Sign in
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
