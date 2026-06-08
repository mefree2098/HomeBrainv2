import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, CheckCircle2, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { getNotifications, clearNotification, clearNotifications, type HomeBrainNotification, type NotificationChannel } from '@/api/notifications';
import { useToast } from '@/hooks/useToast';
import { cn } from '@/lib/utils';

type ChannelFilter = 'all' | NotificationChannel;

const filters: Array<{ value: ChannelFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'securityCritical', label: 'Critical' },
  { value: 'normal', label: 'Normal' }
];

const formatDate = (value?: string) => {
  if (!value) return 'Unknown time';
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  } catch {
    return value;
  }
};

export function Notifications() {
  const { toast } = useToast();
  const [filter, setFilter] = useState<ChannelFilter>('all');
  const [includeHistory, setIncludeHistory] = useState(false);
  const [notifications, setNotifications] = useState<HomeBrainNotification[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadNotifications = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await getNotifications({
        channel: filter,
        includeCleared: includeHistory,
        includeResolved: includeHistory,
        limit: 150
      });
      setNotifications(response.notifications || []);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load notifications.';
      toast({ title: 'Notifications unavailable', description: message, variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }, [filter, includeHistory, toast]);

  useEffect(() => {
    loadNotifications();
  }, [loadNotifications]);

  const activeCount = useMemo(
    () => notifications.filter((item) => !item.clearedAt && !item.resolvedAt).length,
    [notifications]
  );

  const handleClearAll = async () => {
    try {
      await clearNotifications(filter);
      await loadNotifications();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to clear notifications.';
      toast({ title: 'Clear failed', description: message, variant: 'destructive' });
    }
  };

  const handleClearOne = async (notificationId: string) => {
    try {
      await clearNotification(notificationId);
      await loadNotifications();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to clear notification.';
      toast({ title: 'Clear failed', description: message, variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Notifications</h1>
          <p className="mt-2 text-sm text-muted-foreground">Security alerts and HomeBrain device notices.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={loadNotifications} disabled={isLoading} className="gap-2">
            <RefreshCw className={cn('h-4 w-4', isLoading ? 'animate-spin' : '')} />
            Refresh
          </Button>
          <Button variant="destructive" onClick={handleClearAll} disabled={activeCount === 0 || isLoading} className="gap-2">
            <CheckCircle2 className="h-4 w-4" />
            {filter === 'securityCritical' ? 'Clear Critical' : filter === 'normal' ? 'Clear Normal' : 'Clear All'}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[1.35rem] border border-white/10 bg-white/10 p-3 dark:bg-slate-950/20">
        <div className="inline-flex rounded-full border border-white/10 bg-white/10 p-1 dark:bg-slate-950/30">
          {filters.map((entry) => (
            <button
              key={entry.value}
              type="button"
              onClick={() => setFilter(entry.value)}
              className={cn(
                'rounded-full px-4 py-2 text-sm font-semibold transition-colors',
                filter === entry.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={includeHistory}
            onChange={(event) => setIncludeHistory(event.target.checked)}
            className="h-4 w-4 rounded border-border"
          />
          Show history
        </label>
      </div>

      {notifications.length === 0 ? (
        <div className="flex min-h-[18rem] flex-col items-center justify-center rounded-[1.5rem] border border-white/10 bg-white/10 text-center dark:bg-slate-950/20">
          <Bell className="mb-3 h-9 w-9 text-muted-foreground" />
          <p className="font-semibold text-foreground">No notifications</p>
          <p className="mt-1 text-sm text-muted-foreground">No matching HomeBrain notifications are waiting.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {notifications.map((notification) => {
            const critical = notification.channel === 'securityCritical';
            return (
              <div key={notification.id} className="rounded-[1.35rem] border border-white/10 bg-white/10 p-4 dark:bg-slate-950/20">
                <div className="flex items-start gap-3">
                  <div className={cn('mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full', critical ? 'bg-red-500/15 text-red-500' : 'bg-amber-400/15 text-amber-500')}>
                    {critical ? <ShieldAlert className="h-5 w-5" /> : <Bell className="h-5 w-5" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold text-foreground">{notification.title}</h2>
                      {critical ? <Badge variant="destructive">Critical</Badge> : <Badge variant="secondary">Normal</Badge>}
                      {notification.resolvedAt ? <Badge variant="outline">Resolved</Badge> : null}
                      {notification.clearedAt ? <Badge variant="outline">Cleared</Badge> : null}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{notification.message}</p>
                    <p className="mt-2 text-xs text-muted-foreground">{formatDate(notification.occurredAt)}</p>
                  </div>
                  {!notification.clearedAt && !notification.resolvedAt ? (
                    <Button variant="ghost" size="icon" onClick={() => handleClearOne(notification.id)} title="Clear notification">
                      <XCircle className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default Notifications;
