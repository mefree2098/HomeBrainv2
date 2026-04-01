import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { VoiceSelector } from "@/components/VoiceSelector"
import {
  Users,
  Plus,
  Mic,
  Volume2,
  User,
  Settings,
  Play,
  Trash2
} from "lucide-react"
import {
  getUserProfiles,
  saveUserProfile,
  getAvailableVoices,
  updateUserProfile,
  type AlexaProfileMapping
} from "@/api/profiles"
import { generateVoicePreview, playAudioBlob } from "@/api/elevenLabs"
import { useToast } from "@/hooks/useToast"
import { useForm } from "react-hook-form"
import { useAuth } from "@/contexts/AuthContext"
import { Checkbox } from "@/components/ui/checkbox"

const ALEXA_RESPONSE_MODE_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "audio", label: "ElevenLabs audio when available" },
  { value: "ssml", label: "Alexa SSML voice" },
  { value: "text", label: "Plain Alexa voice" }
]

const blankAlexaMapping = (): AlexaProfileMapping => ({
  personId: "",
  speakerLabel: "",
  householdId: "",
  locale: "en-US",
  defaultForHousehold: false,
  fallback: false,
  enabled: true
})

const normalizeAlexaMappingsForForm = (value: any): AlexaProfileMapping[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value.map((entry) => ({
    personId: String(entry?.personId || ""),
    speakerLabel: String(entry?.speakerLabel || ""),
    householdId: String(entry?.householdId || ""),
    locale: String(entry?.locale || "en-US"),
    alexaUserId: String(entry?.alexaUserId || ""),
    alexaAccountId: String(entry?.alexaAccountId || ""),
    defaultForHousehold: entry?.defaultForHousehold === true,
    fallback: entry?.fallback === true,
    enabled: entry?.enabled !== false
  }))
}

const normalizeAlexaMappingsForPayload = (mappings: AlexaProfileMapping[]): AlexaProfileMapping[] =>
  (Array.isArray(mappings) ? mappings : [])
    .map((entry) => ({
      personId: String(entry?.personId || "").trim(),
      speakerLabel: String(entry?.speakerLabel || "").trim(),
      householdId: String(entry?.householdId || "").trim(),
      locale: String(entry?.locale || "").trim(),
      alexaUserId: String(entry?.alexaUserId || "").trim(),
      alexaAccountId: String(entry?.alexaAccountId || "").trim(),
      defaultForHousehold: entry?.defaultForHousehold === true,
      fallback: entry?.fallback === true,
      enabled: entry?.enabled !== false
    }))
    .filter((entry) => entry.personId || entry.defaultForHousehold || entry.fallback)

export function UserProfiles() {
  const { toast } = useToast()
  const { isAdmin } = useAuth()
  const [profiles, setProfiles] = useState([])
  const [voices, setVoices] = useState([])
  const [loading, setLoading] = useState(true)
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [editingProfile, setEditingProfile] = useState<any>(null)
  const [playingVoice, setPlayingVoice] = useState<string | null>(null)
  const [createAlexaMappings, setCreateAlexaMappings] = useState<AlexaProfileMapping[]>([])
  const [editAlexaMappings, setEditAlexaMappings] = useState<AlexaProfileMapping[]>([])
  const { register, handleSubmit, reset, setValue, watch } = useForm()
  const { 
    register: registerEdit, 
    handleSubmit: handleSubmitEdit, 
    reset: resetEdit, 
    setValue: setValueEdit, 
    watch: watchEdit 
  } = useForm()

  useEffect(() => {
    let cancelled = false;

    const fetchData = async () => {
      try {
        console.log('Fetching user profiles and voices data')
        const [profilesData, voicesData] = await Promise.all([
          getUserProfiles(),
          getAvailableVoices()
        ])

        // Only update state if component hasn't been unmounted
        if (!cancelled) {
          setProfiles(profilesData.profiles)
          setVoices(voicesData.voices)
        }
      } catch (error) {
        console.error('Failed to fetch data:', error)
        // Only show error if component hasn't been unmounted
        if (!cancelled) {
          toast({
            title: "Error",
            description: "Failed to load user profiles",
            variant: "destructive"
          })
        }
      } finally {
        // Only update loading state if component hasn't been unmounted
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    fetchData()

    // Cleanup function to prevent state updates if component unmounts
    return () => {
      cancelled = true;
    }
  }, []) // toast is stable from useToast hook, safe to exclude

  const handleCreateDialogChange = (open: boolean) => {
    setIsCreateDialogOpen(open)
    if (!open) {
      reset()
      setCreateAlexaMappings([])
    }
  }

  const handleEditDialogChange = (open: boolean) => {
    setIsEditDialogOpen(open)
    if (!open) {
      setEditingProfile(null)
      resetEdit()
      setEditAlexaMappings([])
    }
  }

  const updateAlexaMappingAtIndex = (
    mode: "create" | "edit",
    index: number,
    updates: Partial<AlexaProfileMapping>
  ) => {
    const setter = mode === "create" ? setCreateAlexaMappings : setEditAlexaMappings
    setter((current) => current.map((entry, entryIndex) => (
      entryIndex === index ? { ...entry, ...updates } : entry
    )))
  }

  const removeAlexaMappingAtIndex = (mode: "create" | "edit", index: number) => {
    const setter = mode === "create" ? setCreateAlexaMappings : setEditAlexaMappings
    setter((current) => current.filter((_, entryIndex) => entryIndex !== index))
  }

  const addAlexaMapping = (mode: "create" | "edit") => {
    const setter = mode === "create" ? setCreateAlexaMappings : setEditAlexaMappings
    setter((current) => [...current, blankAlexaMapping()])
  }

  const renderAlexaMappingsEditor = (mode: "create" | "edit") => {
    const mappings = mode === "create" ? createAlexaMappings : editAlexaMappings

    return (
      <div className="space-y-3 rounded-xl border border-border/60 bg-muted/20 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Alexa Speaker Mappings</p>
            <p className="text-xs text-muted-foreground">
              Match recognized Alexa speakers or households to this HomeBrain voice profile.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => addAlexaMapping(mode)}>
            <Plus className="mr-1 h-3 w-3" />
            Add Mapping
          </Button>
        </div>

        {mappings.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 px-3 py-4 text-xs text-muted-foreground">
            No Alexa mappings yet. Add one to link a person ID, set a household default, or mark this profile as a fallback.
          </div>
        ) : (
          <div className="space-y-3">
            {mappings.map((mapping, index) => (
              <div key={`${mode}-alexa-mapping-${index}`} className="space-y-3 rounded-lg border border-border/70 bg-background/70 p-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Speaker Label</label>
                    <Input
                      value={mapping.speakerLabel || ""}
                      onChange={(event) => updateAlexaMappingAtIndex(mode, index, { speakerLabel: event.target.value })}
                      placeholder="e.g., Matt Echo"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Alexa Person ID</label>
                    <Input
                      value={mapping.personId || ""}
                      onChange={(event) => updateAlexaMappingAtIndex(mode, index, { personId: event.target.value })}
                      placeholder="amzn1.ask.person..."
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Household ID</label>
                    <Input
                      value={mapping.householdId || ""}
                      onChange={(event) => updateAlexaMappingAtIndex(mode, index, { householdId: event.target.value })}
                      placeholder="Household identifier"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Locale</label>
                    <Input
                      value={mapping.locale || ""}
                      onChange={(event) => updateAlexaMappingAtIndex(mode, index, { locale: event.target.value })}
                      placeholder="en-US"
                      className="mt-1"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={mapping.enabled !== false}
                      onCheckedChange={(checked) => updateAlexaMappingAtIndex(mode, index, { enabled: checked === true })}
                    />
                    Enabled
                  </label>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={mapping.defaultForHousehold === true}
                      onCheckedChange={(checked) => updateAlexaMappingAtIndex(mode, index, { defaultForHousehold: checked === true })}
                    />
                    Default for household
                  </label>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={mapping.fallback === true}
                      onCheckedChange={(checked) => updateAlexaMappingAtIndex(mode, index, { fallback: checked === true })}
                    />
                    Fallback profile
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto text-muted-foreground"
                    onClick={() => removeAlexaMappingAtIndex(mode, index)}
                  >
                    <Trash2 className="mr-1 h-3 w-3" />
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  const renderAlexaPreferencesEditor = (mode: "create" | "edit") => {
    const watchField = mode === "create" ? watch : watchEdit
    const setFieldValue = mode === "create" ? setValue : setValueEdit
    const responseModeValue = watchField("alexaResponseMode") || "auto"
    const preferredLocaleValue = watchField("alexaPreferredLocale") || "en-US"
    const allowPersonalizationValue = watchField("alexaAllowPersonalization") !== false
    const includeFallbackValue = watchField("alexaIncludeFallbackText") === true

    return (
      <div className="space-y-3 rounded-xl border border-border/60 bg-muted/20 p-4">
        <div>
          <p className="text-sm font-medium">Alexa Response Preferences</p>
          <p className="text-xs text-muted-foreground">
            Control how Alexa custom-skill responses should be spoken for this profile.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Response Mode</label>
            <Select
              value={responseModeValue}
              onValueChange={(value) => setFieldValue("alexaResponseMode", value)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select Alexa response mode" />
              </SelectTrigger>
              <SelectContent>
                {ALEXA_RESPONSE_MODE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Preferred Locale</label>
            <Input
              value={preferredLocaleValue}
              onChange={(event) => setFieldValue("alexaPreferredLocale", event.target.value)}
              placeholder="en-US"
              className="mt-1"
            />
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/70 px-3 py-3 text-sm">
            <Checkbox
              checked={allowPersonalizationValue}
              onCheckedChange={(checked) => setFieldValue("alexaAllowPersonalization", checked === true)}
            />
            <span>Allow personalization for mapped Alexa voice users</span>
          </label>
          <label className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/70 px-3 py-3 text-sm">
            <Checkbox
              checked={includeFallbackValue}
              onCheckedChange={(checked) => setFieldValue("alexaIncludeFallbackText", checked === true)}
            />
            <span>Append Alexa fallback speech after custom audio</span>
          </label>
        </div>
      </div>
    )
  }

  const handleCreateProfile = async (data: any) => {
    try {
      console.log('Creating user profile:', data)
      const wakeWords = data.wakeWords.split(',').map((word: string) => word.trim()).filter(Boolean)

      const result = await saveUserProfile({
        name: data.name,
        wakeWords,
        voiceId: data.voiceId,
        systemPrompt: data.systemPrompt,
        alexaMappings: normalizeAlexaMappingsForPayload(createAlexaMappings),
        alexaPreferences: {
          responseMode: data.alexaResponseMode || "auto",
          preferredLocale: data.alexaPreferredLocale || "en-US",
          allowPersonalization: data.alexaAllowPersonalization !== false,
          includeAudioFallbackText: data.alexaIncludeFallbackText === true
        }
      })

      setProfiles(prev => [...prev, result.profile])
      setIsCreateDialogOpen(false)
      reset()
      setCreateAlexaMappings([])

      toast({
        title: "Profile Created",
        description: "Character created. Wake-word training and instant acknowledgment lines are now being prepared."
      })
    } catch (error) {
      console.error('Failed to create profile:', error)
      toast({
        title: "Error",
        description: "Failed to create user profile",
        variant: "destructive"
      })
    }
  }

  const handlePlayVoicePreview = async (voiceId: string, voiceName: string) => {
    try {
      setPlayingVoice(voiceId)
      console.log('Playing voice preview for:', voiceName)
      
      const audioBlob = await generateVoicePreview({ 
        voiceId,
        text: `Hello! This is ${voiceName} from your HomeBrain system. I'm ready to assist you with your smart home needs.`
      })
      
      await playAudioBlob(audioBlob)
      
      toast({
        title: "Voice Preview",
        description: `Playing preview of ${voiceName}`
      })
    } catch (error) {
      console.error('Failed to play voice preview:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to play voice preview",
        variant: "destructive"
      })
    } finally {
      setPlayingVoice(null)
    }
  }

  const handleEditProfile = (profile: any) => {
    console.log('Opening edit dialog for profile:', profile.name)
    setEditingProfile(profile)
    
    // Pre-fill the edit form with existing profile data
    setValueEdit("name", profile.name)
    setValueEdit("voiceId", profile.voiceId)
    setValueEdit("wakeWords", profile.wakeWords.join(', '))
    setValueEdit("systemPrompt", profile.systemPrompt || '')
    setValueEdit("alexaResponseMode", profile.alexaPreferences?.responseMode || "auto")
    setValueEdit("alexaPreferredLocale", profile.alexaPreferences?.preferredLocale || "en-US")
    setValueEdit("alexaAllowPersonalization", profile.alexaPreferences?.allowPersonalization !== false)
    setValueEdit("alexaIncludeFallbackText", profile.alexaPreferences?.includeAudioFallbackText === true)
    setEditAlexaMappings(normalizeAlexaMappingsForForm(profile.alexaMappings))
    
    setIsEditDialogOpen(true)
  }

  const handleUpdateProfile = async (data: any) => {
    try {
      console.log('Updating user profile:', editingProfile._id, data)
      const wakeWords = data.wakeWords.split(',').map((word: string) => word.trim()).filter(Boolean)

      const result = await updateUserProfile(editingProfile._id, {
        name: data.name,
        wakeWords,
        voiceId: data.voiceId,
        systemPrompt: data.systemPrompt,
        alexaMappings: normalizeAlexaMappingsForPayload(editAlexaMappings),
        alexaPreferences: {
          responseMode: data.alexaResponseMode || "auto",
          preferredLocale: data.alexaPreferredLocale || "en-US",
          allowPersonalization: data.alexaAllowPersonalization !== false,
          includeAudioFallbackText: data.alexaIncludeFallbackText === true
        }
      })

      // Update the profile in the local state
      setProfiles(prev => prev.map(p => 
        p._id === editingProfile._id ? result.profile : p
      ))
      
      setIsEditDialogOpen(false)
      setEditingProfile(null)
      resetEdit()
      setEditAlexaMappings([])

      toast({
        title: "Profile Updated",
        description: "Character updated. Wake-word models and acknowledgment lines are being refreshed."
      })
    } catch (error) {
      console.error('Failed to update profile:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to update user profile",
        variant: "destructive"
      })
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  const activeProfiles = profiles.filter(profile => profile.active).length

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
            Voice Profiles
          </h1>
          <p className="text-muted-foreground mt-2">
            {isAdmin
              ? "Manage voice recognition, wake words, and assistant personas"
              : "Browse the voice personas configured for your HomeBrain assistant"}
          </p>
        </div>

        {isAdmin ? (
        <>
        <Dialog open={isCreateDialogOpen} onOpenChange={handleCreateDialogChange}>
          <DialogTrigger asChild>
            <Button className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white shadow-lg">
              <Plus className="h-4 w-4 mr-2" />
              Create Voice Profile
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-background/95 dark:bg-slate-950/95 border border-border/60 max-w-2xl" aria-describedby="create-profile-description">
            <DialogHeader>
              <DialogTitle>Create Voice Profile</DialogTitle>
              <p id="create-profile-description" className="text-sm text-muted-foreground">
                Create a new voice persona with personalized wake words and AI settings
              </p>
            </DialogHeader>
            <form onSubmit={handleSubmit(handleCreateProfile)} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="text-sm font-medium">Name</label>
                  <Input
                    {...register("name", { required: true })}
                    placeholder="e.g., Anna"
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Voice</label>
                  <VoiceSelector
                    voices={voices}
                    value={watch("voiceId")}
                    onValueChange={(value) => setValue("voiceId", value)}
                    onPlayPreview={handlePlayVoicePreview}
                    playingVoice={playingVoice}
                    placeholder="Select voice"
                    className="mt-1"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium">Wake Words</label>
                <Input
                  {...register("wakeWords", { required: true })}
                  placeholder="e.g., Anna, Hey Anna"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Separate multiple wake words with commas
                </p>
              </div>
              <div>
                <label className="text-sm font-medium">AI System Prompt</label>
                <Textarea
                  {...register("systemPrompt")}
                  placeholder="You are Anna, a helpful and friendly home assistant..."
                  className="mt-1 min-h-[100px]"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  This defines the AI personality and behavior for this user
                </p>
              </div>
              {renderAlexaPreferencesEditor("create")}
              {renderAlexaMappingsEditor("create")}
              <div className="flex gap-2 pt-4">
                <Button type="submit" className="flex-1">Create Profile</Button>
                <Button type="button" variant="outline" onClick={() => handleCreateDialogChange(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>

        {/* Edit Profile Dialog */}
        <Dialog open={isEditDialogOpen} onOpenChange={handleEditDialogChange}>
          <DialogContent className="bg-background/95 dark:bg-slate-950/95 border border-border/60 max-w-2xl" aria-describedby="edit-profile-description">
            <DialogHeader>
              <DialogTitle>Edit Voice Profile</DialogTitle>
              <p id="edit-profile-description" className="text-sm text-muted-foreground">
                Modify the settings for {editingProfile?.name || 'this voice profile'}
              </p>
            </DialogHeader>
            <form onSubmit={handleSubmitEdit(handleUpdateProfile)} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="text-sm font-medium">Name</label>
                  <Input
                    {...registerEdit("name", { required: true })}
                    placeholder="e.g., Anna"
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Voice</label>
                  <VoiceSelector
                    voices={voices}
                    value={watchEdit("voiceId")}
                    onValueChange={(value) => setValueEdit("voiceId", value)}
                    onPlayPreview={handlePlayVoicePreview}
                    playingVoice={playingVoice}
                    placeholder="Select voice"
                    className="mt-1"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium">Wake Words</label>
                <Input
                  {...registerEdit("wakeWords", { required: true })}
                  placeholder="e.g., Anna, Hey Anna"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Separate multiple wake words with commas
                </p>
              </div>
              <div>
                <label className="text-sm font-medium">AI System Prompt</label>
                <Textarea
                  {...registerEdit("systemPrompt")}
                  placeholder="You are Anna, a helpful and friendly home assistant..."
                  className="mt-1 min-h-[100px]"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  This defines the AI personality and behavior for this voice persona
                </p>
              </div>
              {renderAlexaPreferencesEditor("edit")}
              {renderAlexaMappingsEditor("edit")}
              <div className="flex gap-2 pt-4">
                <Button type="submit" className="flex-1">Update Profile</Button>
                <Button type="button" variant="outline" onClick={() => handleEditDialogChange(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
        </>
        ) : null}
      </div>

      {!isAdmin ? (
        <div className="rounded-[1.5rem] border border-border/70 bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          Standard users can review voice profiles and preview voices, but only admins can edit assistant personas.
        </div>
      ) : null}

      {/* Profile Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-3 border-dashed border-blue-300 bg-blue-50/70 dark:bg-blue-900/20">
          <CardContent className="pt-4">
            <p className="text-sm text-blue-900 dark:text-blue-100">
              Character onboarding is automatic: when you create or update a profile, HomeBrain trains OpenWakeWord models for
              wake phrases and pre-generates multiple spoken acknowledgment lines for that character voice.
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/20 dark:to-blue-800/20 border-blue-200 dark:border-blue-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Profiles</CardTitle>
            <Users className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-700 dark:text-blue-300">
              {profiles.length}
            </div>
            <p className="text-xs text-blue-600/80 dark:text-blue-400/80">
              User profiles created
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-green-50 to-green-100 dark:from-green-900/20 dark:to-green-800/20 border-green-200 dark:border-green-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active</CardTitle>
            <User className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-700 dark:text-green-300">
              {activeProfiles}
            </div>
            <p className="text-xs text-green-600/80 dark:text-green-400/80">
              Currently active
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-800/20 border-purple-200 dark:border-purple-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Voices</CardTitle>
            <Volume2 className="h-4 w-4 text-purple-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-purple-700 dark:text-purple-300">
              {voices.length}
            </div>
            <p className="text-xs text-purple-600/80 dark:text-purple-400/80">
              Available voices
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Profiles Grid */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {profiles.map((profile) => (
          <Card key={profile._id} className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg hover:shadow-xl transition-all duration-300">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`p-3 rounded-full ${profile.active ? 'bg-green-500' : 'bg-gray-400'} text-white`}>
                    <User className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">{profile.name}</CardTitle>
                    <p className="text-sm text-muted-foreground">
                      {profile.wakeWords.length} wake words
                    </p>
                  </div>
                </div>
                <Badge variant={profile.active ? "default" : "secondary"}>
                  {profile.active ? "Active" : "Inactive"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-sm font-medium text-muted-foreground mb-1">Wake Words</p>
                <div className="flex flex-wrap gap-1">
                  {profile.wakeWords.map((word, index) => (
                    <Badge key={index} variant="outline" className="text-xs">
                      {word}
                    </Badge>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-sm font-medium text-muted-foreground mb-1">Voice</p>
                <div className="flex items-center gap-2">
                  <Volume2 className="h-3 w-3" />
                  <span className="text-sm">
                    {voices.find(v => v.id === profile.voiceId)?.name || 'Unknown Voice'}
                  </span>
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="h-6 w-6 p-0"
                    disabled={playingVoice === profile.voiceId}
                    onClick={() => handlePlayVoicePreview(
                      profile.voiceId, 
                      voices.find(v => v.id === profile.voiceId)?.name || 'Unknown Voice'
                    )}
                  >
                    {playingVoice === profile.voiceId ? (
                      <div className="animate-spin rounded-full h-3 w-3 border-b border-current" />
                    ) : (
                      <Play className="h-3 w-3" />
                    )}
                  </Button>
                </div>
              </div>

              <div>
                <p className="text-sm font-medium text-muted-foreground mb-1">AI Personality</p>
                <p className="text-xs text-muted-foreground bg-gray-50 dark:bg-gray-800 p-2 rounded line-clamp-3">
                  {profile.systemPrompt || 'Default system prompt'}
                </p>
              </div>

              <div>
                <p className="text-sm font-medium text-muted-foreground mb-1">Alexa Matching</p>
                {Array.isArray(profile.alexaMappings) && profile.alexaMappings.length > 0 ? (
                  <div className="space-y-2">
                    {profile.alexaMappings.slice(0, 3).map((mapping, index) => (
                      <div key={`${profile._id}-mapping-${index}`} className="rounded bg-gray-50 p-2 text-xs text-muted-foreground dark:bg-gray-800">
                        <div className="font-medium text-foreground">
                          {mapping?.speakerLabel || mapping?.personId || mapping?.householdId || "Alexa mapping"}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {mapping?.personId ? <Badge variant="outline" className="text-[10px]">Person</Badge> : null}
                          {mapping?.defaultForHousehold ? <Badge variant="outline" className="text-[10px]">Household Default</Badge> : null}
                          {mapping?.fallback ? <Badge variant="outline" className="text-[10px]">Fallback</Badge> : null}
                          {mapping?.householdId ? <Badge variant="outline" className="text-[10px]">{mapping.householdId}</Badge> : null}
                        </div>
                      </div>
                    ))}
                    {profile.alexaMappings.length > 3 ? (
                      <p className="text-[11px] text-muted-foreground">
                        {profile.alexaMappings.length - 3} more mapping{profile.alexaMappings.length - 3 === 1 ? "" : "s"}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground bg-gray-50 dark:bg-gray-800 p-2 rounded">
                    No Alexa speaker or household mappings configured.
                  </p>
                )}
              </div>

              <div>
                <p className="text-sm font-medium text-muted-foreground mb-1">Alexa Response</p>
                <p className="text-xs text-muted-foreground bg-gray-50 dark:bg-gray-800 p-2 rounded">
                  {profile.alexaPreferences?.responseMode || "auto"} • Locale {profile.alexaPreferences?.preferredLocale || "en-US"} • Personalization {profile.alexaPreferences?.allowPersonalization === false ? "off" : "on"}
                  {profile.alexaPreferences?.includeAudioFallbackText ? " • Fallback speech on" : ""}
                </p>
              </div>

              {isAdmin ? (
                <div className="flex gap-2">
                  <Button 
                    variant="outline" 
                    size="sm" 
                    className="flex-1"
                    onClick={() => handleEditProfile(profile)}
                  >
                    <Settings className="h-3 w-3 mr-1" />
                    Edit
                  </Button>
                  <Button variant="outline" size="sm" className="flex-1">
                    <Mic className="h-3 w-3 mr-1" />
                    Train
                  </Button>
                </div>
              ) : null}

              <div className="text-xs text-muted-foreground bg-gray-50 dark:bg-gray-800 p-2 rounded">
                <strong>Test:</strong> Say "{profile.wakeWords[0]}, hello" to test voice recognition
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {profiles.length === 0 && (
        <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Users className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Voice Profiles</h3>
            <p className="text-muted-foreground text-center mb-4">
              {isAdmin
                ? "Create voice profiles for personalized wake words and AI responses"
                : "No voice profiles are configured yet."}
            </p>
            {isAdmin ? (
              <Button
                onClick={() => setIsCreateDialogOpen(true)}
                className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white"
              >
                <Plus className="h-4 w-4 mr-2" />
                Create Your First Voice Profile
              </Button>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
