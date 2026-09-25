import { useEffect, useState } from "react"
import { getIntegrationCapabilityProviders, updateIntegrationCapabilityPreference, type IntegrationCapabilityProviders } from "@/api/integrations"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const preferenceValue = (data: IntegrationCapabilityProviders) => data.preference.mode === "selected" && data.preference.moduleId
  ? `${data.preference.moduleId}::${data.preference.resourceId}` : "__auto__"

export function IndoorClimateSourceCard() {
  const [data, setData] = useState<IntegrationCapabilityProviders | null>(null)
  const [selection, setSelection] = useState("__auto__")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [saved, setSaved] = useState(false)

  const load = async () => {
    setBusy(true)
    setError("")
    try {
      const response = await getIntegrationCapabilityProviders("indoor_climate")
      setData(response.data)
      setSelection(preferenceValue(response.data))
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to load indoor climate sources.")
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void load() }, [])

  const options = (data?.resources || []).map((resource) => ({
    value: `${resource.moduleId}::${resource.id}`,
    label: `${resource.label}${resource.room ? ` · ${resource.room}` : ""}${resource.online === false ? " (offline)" : ""}`
  }))
  if (selection !== "__auto__" && !options.some((option) => option.value === selection)) {
    options.push({ value: selection, label: "Saved source (currently unavailable)" })
  }

  const save = async () => {
    setBusy(true)
    setError("")
    setSaved(false)
    try {
      const [moduleId = "", resourceId = ""] = selection === "__auto__" ? [] : selection.split("::")
      const response = await updateIntegrationCapabilityPreference("indoor_climate", {
        mode: selection === "__auto__" ? "auto" : "selected", moduleId, resourceId
      })
      setData(response.data)
      setSelection(preferenceValue(response.data))
      setSaved(true)
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to save indoor climate source.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Climate data source</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <Label htmlFor="indoor-climate-source">Indoor climate source</Label>
        <Select value={selection} onValueChange={(value) => { setSelection(value); setSaved(false) }} disabled={!data || busy}>
          <SelectTrigger id="indoor-climate-source"><SelectValue placeholder="Choose a sensor" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__auto__">Automatic (configured Govee monitor)</SelectItem>
            {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground">Choose the sensor for indoor readings on the dashboard and weather history. This setting is shared across the web app, iPhones, and iPads.</p>
        <div className="flex gap-2">
          <Button type="button" onClick={() => void save()} disabled={!data || busy || selection === preferenceValue(data)}>Save source</Button>
          <Button type="button" variant="outline" onClick={() => void load()} disabled={busy}>Refresh sources</Button>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {saved && <p role="status" className="text-sm text-muted-foreground">Indoor climate source saved.</p>}
      </CardContent>
    </Card>
  )
}
