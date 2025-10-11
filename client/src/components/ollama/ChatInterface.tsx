import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { sendChatMessage, getChatHistory, clearChatHistory } from '@/api/ollama';
import { PaperAirplaneIcon, TrashIcon } from '@heroicons/react/24/outline';
import { useToast } from '@/hooks/useToast';

interface ChatMessage {
  _id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  model: string;
}

interface ChatInterfaceProps {
  activeModel: string | null;
}

export default function ChatInterface({ activeModel }: ChatInterfaceProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    loadHistory();
  }, []);

  const loadHistory = async () => {
    try {
      setLoadingHistory(true);
      const data = await getChatHistory(50);
      setMessages(data.history || []);
    } catch (error: any) {
      console.error('Error loading chat history:', error);
    } finally {
      setLoadingHistory(false);
    }
  };

  const handleSend = async () => {
    if (!inputMessage.trim()) return;

    if (!activeModel) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'No active model selected. Please select a model first.',
      });
      return;
    }

    const userMessage: ChatMessage = {
      role: 'user',
      content: inputMessage,
      timestamp: new Date(),
      model: activeModel,
    };

    setMessages(prev => [...prev, userMessage]);
    setInputMessage('');
    setLoading(true);

    try {
      // Build conversation history for context
      const conversationHistory = messages.map(m => ({
        role: m.role,
        content: m.content,
      }));

      const response = await sendChatMessage(inputMessage, activeModel, conversationHistory);

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: response.message,
        timestamp: new Date(),
        model: response.model,
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error: any) {
      console.error('Error sending message:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message || 'Failed to send message',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleClearHistory = async () => {
    try {
      await clearChatHistory();
      setMessages([]);
      toast({
        title: 'Success',
        description: 'Chat history cleared',
      });
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message || 'Failed to clear history',
      });
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <Card className="flex flex-col h-[600px]">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Chat with {activeModel || 'Model'}</CardTitle>
        <Button
          variant="outline"
          size="sm"
          onClick={handleClearHistory}
          disabled={messages.length === 0}
        >
          <TrashIcon className="h-4 w-4 mr-2" />
          Clear History
        </Button>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col p-4 gap-4">
        <ScrollArea className="flex-1 pr-4">
          {loadingHistory ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-muted-foreground">Loading chat history...</p>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-muted-foreground">No messages yet. Start a conversation!</p>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((msg, idx) => (
                <div
                  key={msg._id || idx}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg p-3 ${
                      msg.role === 'user'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted'
                    }`}
                  >
                    <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                    <p className="text-xs opacity-70 mt-1">
                      {new Date(msg.timestamp).toLocaleTimeString()}
                    </p>
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="bg-muted rounded-lg p-3">
                    <p className="text-sm text-muted-foreground">Thinking...</p>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </ScrollArea>

        <div className="flex gap-2">
          <Textarea
            value={inputMessage}
            onChange={e => setInputMessage(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder={
              activeModel
                ? 'Type your message... (Shift+Enter for new line)'
                : 'Please select an active model first'
            }
            className="flex-1 min-h-[60px] max-h-[120px]"
            disabled={!activeModel || loading}
          />
          <Button
            onClick={handleSend}
            disabled={!inputMessage.trim() || !activeModel || loading}
            size="lg"
          >
            <PaperAirplaneIcon className="h-5 w-5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
