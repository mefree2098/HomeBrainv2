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
import { useAuth } from "@/contexts/AuthContext"
import { getRegistrationStatus } from "@/api/auth"

type LoginForm = {
  email: string
  password: string
}

export function Login() {
  const [loading, setLoading] = useState(false)
  const [registrationOpen, setRegistrationOpen] = useState(false)
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

  const onSubmit = async (data: LoginForm) => {
    try {
      setLoading(true)
      await login(data.email, data.password)
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
    <div className="flex min-h-screen items-center justify-center px-4 py-8 sm:px-6">
      <Card className="w-full max-w-md rounded-[1.75rem]">
        <CardHeader className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10">
              <img src="/homebrain-brand-64.png" alt="HomeBrain" className="h-7 w-7 rounded object-cover" />
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">HomeBrain</p>
              <CardTitle className="mt-1 text-2xl">Single sign-on</CardTitle>
            </div>
          </div>
          <CardDescription>
            {returnTo ? "Sign in to continue." : "Sign in with your HomeBrain account."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                placeholder="Enter your email"
                {...register("email", { required: true })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder="Enter your password"
                {...register("password", { required: true })}
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing in..." : "Sign In"}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="justify-center">
          {registrationOpen ? (
            <Button
              variant="link"
              className="text-sm text-muted-foreground"
              onClick={() => navigate(returnTo ? `/register?returnTo=${encodeURIComponent(returnTo)}` : "/register")}
            >
              Don't have an account? Sign up
            </Button>
          ) : (
            <p className="text-center text-sm text-muted-foreground">
              New accounts are created by an admin from the Users screen.
            </p>
          )}
        </CardFooter>
      </Card>
    </div>
  )
}
