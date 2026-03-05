import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Home, ArrowLeft } from "lucide-react"
import { useNavigate } from "react-router-dom"

export function BlankPage() {
  const navigate = useNavigate()

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-6">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="drift-slow absolute left-[-8rem] top-[8rem] h-[24rem] w-[24rem] rounded-full bg-cyan-300/28 blur-3xl dark:bg-cyan-500/18" />
        <div className="float-slow absolute right-[-8rem] top-[12rem] h-[22rem] w-[22rem] rounded-full bg-blue-300/20 blur-3xl dark:bg-blue-500/16" />
      </div>

      <Card className="w-full max-w-xl rounded-[2rem]">
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <div className="mb-6 rounded-[1.4rem] bg-gradient-to-br from-cyan-400 to-blue-500 p-4 text-white shadow-lg shadow-cyan-500/25">
            <Home className="h-8 w-8" />
          </div>
          <p className="section-kicker">Navigation Fault</p>
          <h1 className="mb-2 mt-3 text-3xl font-semibold text-foreground">
            Page Not Found
          </h1>
          <p className="mb-6 max-w-md text-muted-foreground">
            The page you're looking for doesn't exist or has been moved.
          </p>
          <Button onClick={() => navigate("/")}>
            <ArrowLeft className="h-4 w-4" />
            Back to Dashboard
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
