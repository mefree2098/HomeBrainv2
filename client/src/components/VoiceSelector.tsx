import { useState, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Play, Search } from "lucide-react"

interface Voice {
  id: string;
  name: string;
  description?: string;
  category?: string;
  labels?: {
    gender?: string;
    age?: string;
    accent?: string;
  };
}

interface VoiceSelectorProps {
  voices: Voice[];
  value?: string;
  onValueChange: (value: string) => void;
  onPlayPreview?: (voiceId: string, voiceName: string) => void;
  playingVoice?: string;
  placeholder?: string;
  className?: string;
}

export function VoiceSelector({
  voices,
  value,
  onValueChange,
  onPlayPreview,
  playingVoice,
  placeholder = "Select voice",
  className = ""
}: VoiceSelectorProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [isOpen, setIsOpen] = useState(false)

  // Filter voices based on search query
  const filteredVoices = useMemo(() => {
    if (!searchQuery.trim()) {
      return voices;
    }

    const query = searchQuery.toLowerCase().trim();
    return voices.filter(voice => {
      // Search in name
      if (voice.name.toLowerCase().includes(query)) return true;
      
      // Search in description
      if (voice.description?.toLowerCase().includes(query)) return true;
      
      // Search in category
      if (voice.category?.toLowerCase().includes(query)) return true;
      
      // Search in labels
      if (voice.labels) {
        const labelValues = Object.values(voice.labels).join(' ').toLowerCase();
        if (labelValues.includes(query)) return true;
      }
      
      return false;
    });
  }, [voices, searchQuery]);

  // Get current selected voice
  const selectedVoice = voices.find(v => v.id === value);

  const formatVoiceLabel = (voice: Voice) => {
    let label = voice.name;
    
    if (voice.labels) {
      const details = [];
      if (voice.labels.gender) details.push(voice.labels.gender);
      if (voice.labels.age) details.push(voice.labels.age);
      if (voice.labels.accent) details.push(voice.labels.accent);
      
      if (details.length > 0) {
        label += ` (${details.join(', ')})`;
      }
    }
    
    return label;
  };

  return (
    <div className={`flex gap-2 ${className}`}>
      <div className="flex-1">
        <Select 
          value={value || ""} 
          onValueChange={onValueChange}
          open={isOpen}
          onOpenChange={setIsOpen}
        >
          <SelectTrigger>
            <SelectValue placeholder={placeholder}>
              {selectedVoice ? formatVoiceLabel(selectedVoice) : placeholder}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <div className="sticky top-0 z-10 bg-white border-b p-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search voices..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            </div>
            <div className="max-h-60 overflow-y-auto">
              {filteredVoices.length === 0 ? (
                <div className="p-4 text-center text-muted-foreground">
                  No voices found matching "{searchQuery}"
                </div>
              ) : (
                filteredVoices.map((voice) => (
                  <SelectItem key={voice.id} value={voice.id}>
                    <div className="flex flex-col">
                      <span className="font-medium">{voice.name}</span>
                      {voice.labels && (
                        <span className="text-xs text-muted-foreground">
                          {[voice.labels.gender, voice.labels.age, voice.labels.accent]
                            .filter(Boolean)
                            .join(' • ')}
                        </span>
                      )}
                      {voice.description && (
                        <span className="text-xs text-muted-foreground mt-1">
                          {voice.description.length > 50 
                            ? `${voice.description.substring(0, 50)}...` 
                            : voice.description}
                        </span>
                      )}
                    </div>
                  </SelectItem>
                ))
              )}
            </div>
          </SelectContent>
        </Select>
      </div>
      
      {onPlayPreview && (
        <Button 
          type="button"
          variant="outline" 
          size="sm" 
          className="px-3 shrink-0"
          disabled={!value || playingVoice === value}
          onClick={() => {
            if (selectedVoice) {
              onPlayPreview(selectedVoice.id, selectedVoice.name);
            }
          }}
        >
          {playingVoice === value ? (
            <div className="animate-spin rounded-full h-3 w-3 border-b border-current" />
          ) : (
            <Play className="h-3 w-3" />
          )}
        </Button>
      )}
    </div>
  );
}