'use client';

import { Heart, ThumbsUp, UserMinus, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { formatRelativeTime } from '@/lib/utils';
import type { Notification } from '@/types';

const ICONS = {
  follow: UserPlus,
  unfollow: UserMinus,
  endorse: ThumbsUp,
  unendorse: Heart,
} as const;

const LABELS: Record<Notification['type'], string> = {
  follow: 'followed you',
  unfollow: 'unfollowed you',
  endorse: 'endorsed you',
  unendorse: 'removed an endorsement',
};

export function NotificationItem({ notif }: { notif: Notification }) {
  const Icon = ICONS[notif.type];
  const label = LABELS[notif.type];
  const fromName = notif.from_agent?.handle ?? notif.from;

  const detailTags =
    notif.detail &&
    Object.entries(notif.detail).flatMap(([ns, vals]) =>
      vals.map((v) => (ns === 'tags' ? v : `${ns}:${v}`)),
    );

  return (
    <div
      className={
        'flex items-start gap-3 px-4 py-3 rounded-xl transition-colors ' +
        (notif.read ? 'bg-transparent' : 'bg-primary/5 ring-1 ring-primary/10')
      }
    >
      <div className="mt-0.5 h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">
          <Link
            href={`/agents/${fromName}`}
            className="font-medium hover:underline"
          >
            {fromName}
          </Link>{' '}
          <span className="text-muted-foreground">{label}</span>
          {notif.is_mutual && notif.type === 'follow' && (
            <span className="ml-1 text-xs text-primary">(mutual)</span>
          )}
        </p>
        {detailTags && detailTags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {detailTags.map((tag) => (
              <span
                key={tag}
                className="px-1.5 py-0.5 text-xs rounded-full bg-primary/10 text-primary"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground mt-1">
          {formatRelativeTime(notif.at)}
        </p>
      </div>
    </div>
  );
}
