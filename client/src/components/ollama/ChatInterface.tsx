import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { sendChatMessage, getChatHistory, clearChatHistory } from '@/api/ollama';
import {
  ArrowPathIcon,
  PaperAirplaneIcon,
  SparklesIcon,
  TrashIcon,
  UserIcon,
} from '@heroicons/react/24/outline';
import { useToast } from '@/hooks/useToast';
import { Badge } from '@/components/ui/badge';

interface ChatMessage {
  _id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date | string;
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

  const formatTimestamp = (timestamp: Date | string) => {
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) {
      return '';
    }
    return parsed.toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const modelLabel = activeModel || 'No model selected';

  return (
    <Card className="flex h-[min(78vh,760px)] flex-col overflow-hidden border-border/70 bg-card/95">
      <CardHeader className="flex flex-row items-start justify-between gap-4 border-b border-border/50 pb-4">
        <div className="space-y-2">
          <CardTitle className="text-2xl">Chat Playground</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-mono text-xs">
              {modelLabel}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              {messages.length} message{messages.length === 1 ? '' : 's'}
            </Badge>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleClearHistory}
          disabled={messages.length === 0 || loading}
        >
          <TrashIcon className="h-4 w-4 mr-2" />
          Clear History
        </Button>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col p-0">
        <div className="mx-4 mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/60 bg-muted/20">
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-5 sm:px-6">
              {loadingHistory ? (
                <div className="flex min-h-[200px] items-center justify-center gap-2 text-sm text-muted-foreground">
                  <ArrowPathIcon className="h-4 w-4 animate-spin" />
                  Loading chat history...
                </div>
              ) : messages.length === 0 ? (
                <div className="flex min-h-[260px] flex-col items-center justify-center gap-3 text-center">
                  <SparklesIcon className="h-8 w-8 text-muted-foreground" />
                  <p className="text-base font-medium">No conversation yet</p>
                  <p className="max-w-md text-sm text-muted-foreground">
                    Send a message to test your active model and verify local Ollama responses.
                  </p>
                </div>
              ) : (
                messages.map((msg, idx) => {
                  const isUser = msg.role === 'user';
                  const roleLabel = isUser
                    ? 'You'
                    : msg.role === 'assistant'
                      ? 'Assistant'
                      : 'System';

                  return (
                    <div
                      key={msg._id || idx}
                      className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`max-w-[min(88%,760px)] rounded-2xl border px-4 py-3 shadow-sm ${
                          isUser
                            ? 'border-primary/50 bg-primary text-primary-foreground'
                            : 'border-border/60 bg-card/90 text-foreground'
                        }`}
                      >
                        <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide opacity-75">
                          {isUser ? (
                            <UserIcon className="h-3 w-3" />
                          ) : (
                            <SparklesIcon className="h-3 w-3" />
                          )}
                          <span>{roleLabel}</span>
                          {formatTimestamp(msg.timestamp) && (
                            <span className="opacity-70">• {formatTimestamp(msg.timestamp)}</span>
                          )}
                        </div>
                        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                          {msg.content}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
              {loading && (
                <div className="flex justify-start">
                  <div className="rounded-2xl border border-border/60 bg-card/90 px-4 py-3 shadow-sm">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <ArrowPathIcon className="h-4 w-4 animate-spin" />
                      Thinking...
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>
        </div>

        <div className="mt-4 border-t border-border/50 bg-card/80 p-4">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 sm:flex-row sm:items-end">
            <Textarea
              value={inputMessage}
              onChange={e => setInputMessage(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder={
                activeModel
                  ? 'Ask anything about your smart home, automations, or local tasks...'
                  : 'Select an active model in the Models tab first'
              }
              className="min-h-[80px] max-h-[220px] flex-1 resize-y rounded-xl border-border/70 bg-background/90"
              disabled={!activeModel || loading}
            />
            <Button
              onClick={handleSend}
              disabled={!inputMessage.trim() || !activeModel || loading}
              className="h-11 gap-2 px-5"
            >
              {loading ? (
                <ArrowPathIcon className="h-4 w-4 animate-spin" />
              ) : (
                <PaperAirplaneIcon className="h-4 w-4" />
              )}
              <span>{loading ? 'Sending' : 'Send'}</span>
            </Button>
          </div>
          <p className="mx-auto mt-2 w-full max-w-4xl text-xs text-muted-foreground">
            Press Enter to send. Use Shift+Enter for a new line.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
