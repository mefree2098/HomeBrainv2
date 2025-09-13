import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Home, ArrowLeft } from "lucide-react"
import { useNavigate } from "react-router-dom"

export function BlankPage() {
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 dark:from-gray-900 dark:via-blue-900 dark:to-purple-900 flex items-center justify-center p-6">
      <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-xl max-w-md w-full">
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <div className="p-4 rounded-full bg-gradient-to-r from-blue-500 to-purple-600 text-white mb-6">
            <Home className="h-8 w-8" />
          </div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent mb-2">
            Page Not Found
          </h1>
          <p className="text-muted-foreground mb-6">
            The page you're looking for doesn't exist or has been moved.
          </p>
          <Button
            onClick={() => navigate("/")}
            className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white shadow-lg"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}