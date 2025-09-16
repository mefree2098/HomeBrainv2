import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { VoiceSelector } from "@/components/VoiceSelector"
import {
  Users,
  Plus,
  Mic,
  Volume2,
  User,
  Settings,
  Play
} from "lucide-react"
import { getUserProfiles, saveUserProfile, getAvailableVoices, updateUserProfile } from "@/api/profiles"
import { generateVoicePreview, playAudioBlob } from "@/api/elevenLabs"
import { useToast } from "@/hooks/useToast"
import { useForm } from "react-hook-form"

export function UserProfiles() {
  const { toast } = useToast()
  const [profiles, setProfiles] = useState([])
  const [voices, setVoices] = useState([])
  const [loading, setLoading] = useState(true)
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [editingProfile, setEditingProfile] = useState<any>(null)
  const [playingVoice, setPlayingVoice] = useState<string | null>(null)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // toast is stable from useToast hook, safe to exclude

  const handleCreateProfile = async (data: any) => {
    try {
      console.log('Creating user profile:', data)
      const wakeWords = data.wakeWords.split(',').map((word: string) => word.trim()).filter(Boolean)

      const result = await saveUserProfile({
        name: data.name,
        wakeWords,
        voiceId: data.voiceId,
        systemPrompt: data.systemPrompt
      })

      setProfiles(prev => [...prev, result.profile])
      setIsCreateDialogOpen(false)
      reset()

      toast({
        title: "Profile Created",
        description: "User profile has been created successfully"
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
        systemPrompt: data.systemPrompt
      })

      // Update the profile in the local state
      setProfiles(prev => prev.map(p => 
        p._id === editingProfile._id ? result.profile : p
      ))
      
      setIsEditDialogOpen(false)
      setEditingProfile(null)
      resetEdit()

      toast({
        title: "Profile Updated",
        description: "User profile has been updated successfully"
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
            User Profiles
          </h1>
          <p className="text-muted-foreground mt-2">
            Manage voice recognition and personalized AI responses
          </p>
        </div>

        <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white shadow-lg">
              <Plus className="h-4 w-4 mr-2" />
              Create Profile
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-white max-w-2xl" aria-describedby="create-profile-description">
            <DialogHeader>
              <DialogTitle>Create User Profile</DialogTitle>
              <p id="create-profile-description" className="text-sm text-muted-foreground">
                Create a new user profile with personalized voice recognition and AI settings
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
              <div className="flex gap-2 pt-4">
                <Button type="submit" className="flex-1">Create Profile</Button>
                <Button type="button" variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>

        {/* Edit Profile Dialog */}
        <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
          <DialogContent className="bg-white max-w-2xl" aria-describedby="edit-profile-description">
            <DialogHeader>
              <DialogTitle>Edit User Profile</DialogTitle>
              <p id="edit-profile-description" className="text-sm text-muted-foreground">
                Modify the settings for {editingProfile?.name || 'this profile'}
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
                  This defines the AI personality and behavior for this user
                </p>
              </div>
              <div className="flex gap-2 pt-4">
                <Button type="submit" className="flex-1">Update Profile</Button>
                <Button type="button" variant="outline" onClick={() => setIsEditDialogOpen(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Profile Stats */}
      <div className="grid gap-4 md:grid-cols-3">
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
          <Card key={profile._id} className="bg-white/80 backdrop-blur-sm border-0 shadow-lg hover:shadow-xl transition-all duration-300">
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

              <div className="text-xs text-muted-foreground bg-gray-50 dark:bg-gray-800 p-2 rounded">
                <strong>Test:</strong> Say "{profile.wakeWords[0]}, hello" to test voice recognition
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {profiles.length === 0 && (
        <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Users className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No User Profiles</h3>
            <p className="text-muted-foreground text-center mb-4">
              Create user profiles for personalized voice recognition and AI responses
            </p>
            <Button
              onClick={() => setIsCreateDialogOpen(true)}
              className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white"
            >
              <Plus className="h-4 w-4 mr-2" />
              Create Your First Profile
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}