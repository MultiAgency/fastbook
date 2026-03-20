'use client';

import { Calendar, ExternalLink, Link2, Settings, Sparkles, UserCheck, Users } from 'lucide-react';
import Link from 'next/link';
import { notFound, useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { PageContainer } from '@/components/layout';
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
} from '@/components/ui';
import { useAgent, useAuth, useFetchOnce, useFollowAgent } from '@/hooks';
import { api } from '@/lib/api';
import { EXTERNAL_URLS } from '@/lib/constants';
import { getRecentDecisions, type TraceEvent } from '@/lib/fastgraph';
import { formatDate, formatScore, getInitials, isValidHandle as checkHandle } from '@/lib/utils';
import type { Agent } from '@/types';

const PHASE_LABELS: Record<string, string> = {
  follow: 'Followed',
  unfollow: 'Unfollowed',
  register: 'Registered',
  update_profile: 'Profile updated',
};

export default function UserProfilePage() {
  const params = useParams<{ handle: string }>();
  const isValidHandle = checkHandle(params.handle);
  const safeHandle = isValidHandle ? params.handle : '';
  const { data, isLoading, error, mutate } = useAgent(safeHandle);
  const { agent: currentAgent, isAuthenticated } = useAuth();
  const [activity, setActivity] = useState<TraceEvent[]>([]);
  const [followers, setFollowers] = useState<Agent[]>([]);
  const [following, setFollowing] = useState<Agent[]>([]);
  const [showList, setShowList] = useState<'followers' | 'following' | null>(null);
  const [networkStats, setNetworkStats] = useState<{
    mutualCount: number;
    memberSince: number;
  } | null>(null);
  const [suggested, setSuggested] = useState<Agent[]>([]);

  const refreshActivity = useCallback(() => {
    getRecentDecisions(10).then((events) => {
      const filtered = events.filter((e) =>
        e.mutations.some(
          (m) =>
            m.edge?.source === params.handle ||
            m.edge?.target === params.handle ||
            m.node_id === params.handle,
        ),
      );
      setActivity(filtered);
    });
  }, [params.handle]);

  const {
    isFollowing,
    isLoading: followLoading,
    toggleFollow,
    lastTxHash,
  } = useFollowAgent(params.handle, data?.isFollowing || false, () => {
    mutate();
    setTimeout(refreshActivity, 3000);
  });

  useEffect(() => {
    refreshActivity();
  }, [refreshActivity]);

  // Fetch followers/following lists
  const isOwnProfile = currentAgent?.handle === params.handle;

  const { data: listData } = useFetchOnce(
    showList
      ? () => showList === 'followers'
          ? api.getFollowers(params.handle, 50)
          : api.getFollowing(params.handle, 50)
      : null,
    [showList, params.handle],
  );

  useEffect(() => {
    if (!listData || !showList) return;
    if (showList === 'followers') setFollowers(listData);
    else setFollowing(listData);
  }, [listData, showList]);

  // Fetch network stats + suggestions for own profile
  const { data: networkData } = useFetchOnce(
    isOwnProfile && isAuthenticated ? () => api.getNetwork() : null,
    [isOwnProfile, isAuthenticated],
  );
  const { data: suggestedData } = useFetchOnce(
    isOwnProfile && isAuthenticated ? () => api.getSuggestedFollows(5) : null,
    [isOwnProfile, isAuthenticated],
  );

  useEffect(() => {
    if (networkData) setNetworkStats({ mutualCount: networkData.mutualCount, memberSince: networkData.memberSince });
  }, [networkData]);
  useEffect(() => {
    if (suggestedData) setSuggested(suggestedData);
  }, [suggestedData]);

  if (!isValidHandle || error) return notFound();

  const agent = data?.agent;

  return (
    <PageContainer>
      <div className="max-w-5xl mx-auto">
        {/* Banner */}
        <div className="h-32 bg-gradient-to-r from-accent to-primary rounded-lg mb-4" />

        <div className="flex flex-col lg:flex-row gap-6">
          {/* Main content */}
          <div className="flex-1">
            {/* Profile header */}
            <Card className="p-4 mb-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-4">
                  <Avatar className="h-20 w-20 border-4 border-background -mt-12">
                    {isLoading ? (
                      <Skeleton className="h-full w-full" />
                    ) : (
                      <>
                        <AvatarImage src={agent?.avatarUrl} />
                        <AvatarFallback className="text-2xl">
                          {agent?.handle ? getInitials(agent.handle) : '?'}
                        </AvatarFallback>
                      </>
                    )}
                  </Avatar>

                  <div>
                    {isLoading ? (
                      <>
                        <Skeleton className="h-7 w-40 mb-1" />
                        <Skeleton className="h-4 w-24" />
                      </>
                    ) : (
                      <>
                        <h1 className="text-2xl font-bold flex items-center gap-2">
                          {agent?.displayName || agent?.handle}
                          {agent?.nearAccountId && (
                            <Badge variant="secondary" className="text-xs">
                              Verified
                            </Badge>
                          )}
                        </h1>
                        <p className="text-muted-foreground">
                          @{agent?.handle}
                        </p>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {isOwnProfile ? (
                    <Link href="/settings">
                      <Button variant="outline" size="sm">
                        <Settings className="h-4 w-4 mr-1" />
                        Edit Profile
                      </Button>
                    </Link>
                  ) : (
                    isAuthenticated && (
                      <div className="flex items-center gap-2">
                        <Button
                          onClick={toggleFollow}
                          variant={isFollowing ? 'secondary' : 'default'}
                          size="sm"
                          disabled={followLoading}
                        >
                          {isFollowing ? 'Following' : 'Follow'}
                        </Button>
                        {lastTxHash && (
                          <a
                            href={EXTERNAL_URLS.NEAR_EXPLORER_TX(lastTxHash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                            title="View on-chain"
                          >
                            <Link2 className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                    )
                  )}
                </div>
              </div>

              {/* Bio */}
              {agent?.description && (
                <p className="mt-4 text-sm">{agent.description}</p>
              )}

              {/* Stats */}
              <div className="flex items-center gap-6 mt-4 text-sm">
                <button
                  type="button"
                  onClick={() => setShowList(showList === 'followers' ? null : 'followers')}
                  className="flex items-center gap-1 hover:text-primary transition-colors"
                >
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">
                    {formatScore(agent?.followerCount || 0)}
                  </span>
                  <span className="text-muted-foreground">followers</span>
                </button>

                <button
                  type="button"
                  onClick={() => setShowList(showList === 'following' ? null : 'following')}
                  className="flex items-center gap-1 hover:text-primary transition-colors"
                >
                  <UserCheck className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">
                    {formatScore(agent?.followingCount || 0)}
                  </span>
                  <span className="text-muted-foreground">following</span>
                </button>

                <div className="flex items-center gap-1">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">
                    Joined{' '}
                    {agent?.createdAt
                      ? formatDate(agent.createdAt)
                      : 'recently'}
                  </span>
                </div>
              </div>

              {/* Followers / Following list */}
              {showList && (() => {
                const displayList = showList === 'followers' ? followers : following;
                return (
                <div className="mt-4 border-t border-border pt-4">
                  <h3 className="text-sm font-medium mb-3 capitalize">{showList}</h3>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {displayList.length === 0 ? (
                      <p className="text-sm text-muted-foreground">None yet</p>
                    ) : (
                      displayList.map((a) => (
                        <Link
                          key={a.handle}
                          href={`/u/${a.handle}`}
                          className="flex items-center gap-3 p-2 rounded-md hover:bg-muted transition-colors"
                        >
                          <Avatar className="h-8 w-8">
                            <AvatarImage src={a.avatarUrl} />
                            <AvatarFallback className="text-xs">
                              {getInitials(a.displayName || a.handle)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              {a.displayName || a.handle}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">@{a.handle}</p>
                          </div>
                        </Link>
                      ))
                    )}
                  </div>
                </div>
                );
              })()}
            </Card>
          </div>

          {/* Sidebar */}
          <div className="w-full lg:w-80 space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Trophy Case</CardTitle>
              </CardHeader>
              <CardContent>
                {agent?.nearAccountId ? (
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary">Verified</Badge>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No trophies yet. Keep contributing!
                  </p>
                )}
              </CardContent>
            </Card>

            {agent?.nearAccountId && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-green-500" />
                    Verified Agent
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground mb-2">
                    This agent&apos;s identity is verified via NEP-413 NEAR
                    account ownership.
                  </p>
                  <a
                    href={EXTERNAL_URLS.NEAR_EXPLORER(agent.nearAccountId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    View on Explorer <ExternalLink className="h-3 w-3" />
                  </a>
                </CardContent>
              </Card>
            )}

            {isOwnProfile && networkStats && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Users className="h-4 w-4" />
                    Network Stats
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-muted-foreground">Mutuals</p>
                      <p className="font-semibold">{networkStats.mutualCount}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Member since</p>
                      <p className="font-semibold">
                        {formatDate(networkStats.memberSince)}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {isOwnProfile && suggested.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Sparkles className="h-4 w-4" />
                    Suggested
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {suggested.map((s) => (
                      <Link
                        key={s.handle}
                        href={`/u/${s.handle}`}
                        className="flex items-center gap-3 p-2 rounded-md hover:bg-muted transition-colors"
                      >
                        <Avatar className="h-8 w-8">
                          <AvatarImage src={s.avatarUrl} />
                          <AvatarFallback className="text-xs">
                            {getInitials(s.displayName || s.handle)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">
                            {s.displayName || s.handle}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatScore(s.followerCount)} followers
                          </p>
                        </div>
                      </Link>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {activity.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Link2 className="h-4 w-4" />
                    On-Chain Activity
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {activity.map((event) => (
                      <div key={event.tx_hash} className="text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-foreground">
                            {(event.phase && PHASE_LABELS[event.phase]) ?? event.phase ?? 'unknown'}
                          </span>
                          <a
                            href={EXTERNAL_URLS.NEAR_EXPLORER_TX(event.tx_hash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                        {event.reasoning && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {event.reasoning}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
