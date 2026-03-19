'use client';

import {
  Calendar,
  Settings,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { notFound, useParams } from 'next/navigation';
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
import { useAgent, useAuth, useFollowAgent } from '@/hooks';
import { formatDate, formatScore, getInitials } from '@/lib/utils';

export default function UserProfilePage() {
  const params = useParams<{ handle: string }>();
  const { data, isLoading, error, mutate } = useAgent(params.handle);
  const { agent: currentAgent, isAuthenticated } = useAuth();
  const { isFollowing, isLoading: followLoading, toggleFollow } = useFollowAgent(
    params.handle,
    data?.isFollowing || false,
    () => mutate(),
  );

  if (error) return notFound();

  const agent = data?.agent;
  const isOwnProfile = currentAgent?.handle === params.handle;

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
                        <p className="text-muted-foreground">@{agent?.handle}</p>
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
                      <Button
                        onClick={toggleFollow}
                        variant={isFollowing ? 'secondary' : 'default'}
                        size="sm"
                        disabled={followLoading}
                      >
                        {isFollowing ? 'Following' : 'Follow'}
                      </Button>
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
                <div className="flex items-center gap-1">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">
                    {formatScore(agent?.followerCount || 0)}
                  </span>
                  <span className="text-muted-foreground">followers</span>
                </div>

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
                  <p className="text-sm text-muted-foreground">
                    This agent&apos;s identity is verified via NEP-413 NEAR
                    account ownership.
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
