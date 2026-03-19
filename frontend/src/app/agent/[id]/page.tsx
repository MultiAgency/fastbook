'use client';

import {
  ArrowLeft,
  ExternalLink,
  Github,
  Globe,
  Loader2,
  Twitter,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { GlowCard } from '@/components/market';
import { EXTERNAL_URLS } from '@/lib/constants';
import { getProfile, type OnChainProfile } from '@/lib/near-social';

export default function AgentProfilePage() {
  const params = useParams();
  const accountId = params.id as string;
  const [profile, setProfile] = useState<OnChainProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const data = await getProfile(accountId);
      if (data) {
        setProfile(data);
      } else {
        setNotFound(true);
      }
      setLoading(false);
    }
    if (accountId) load();
  }, [accountId]);

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-6 pt-24 pb-16 flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const p = profile?.profile;
  const am = profile?.agent_market;
  const truncatedId =
    accountId.length > 20
      ? `${accountId.slice(0, 12)}...${accountId.slice(-12)}`
      : accountId;

  return (
    <div className="max-w-2xl mx-auto px-6 pt-24 pb-16 space-y-6">
      <Link
        href="/agents"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to agents
      </Link>

      {notFound ? (
        <GlowCard className="p-8 text-center">
          <h2 className="text-xl font-bold text-foreground mb-2">
            No on-chain profile found
          </h2>
          <p className="text-sm text-muted-foreground mb-1">
            Account:{' '}
            <span className="font-mono text-primary">{truncatedId}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            This account exists on NEAR but hasn&apos;t written a profile to
            social.near yet.
          </p>
        </GlowCard>
      ) : (
        <>
          {/* Profile header */}
          <GlowCard className="p-6">
            <div className="flex items-start gap-4">
              {p?.image?.url ? (
                <Image
                  src={p.image.url}
                  alt=""
                  width={64}
                  height={64}
                  className="h-16 w-16 rounded-xl object-cover"
                />
              ) : (
                <div className="h-16 w-16 rounded-xl bg-primary/10 flex items-center justify-center">
                  <span className="text-2xl font-bold text-primary">
                    {(p?.name || accountId)[0]?.toUpperCase()}
                  </span>
                </div>
              )}
              <div className="flex-1 min-w-0">
                <h1 className="text-2xl font-bold text-foreground">
                  {p?.name || am?.handle || 'Unnamed Agent'}
                </h1>
                {am?.handle && p?.name && (
                  <p className="text-sm text-muted-foreground">@{am.handle}</p>
                )}
                <p className="text-xs font-mono text-primary mt-1 break-all">
                  {accountId}
                </p>
              </div>
            </div>

            {p?.description && (
              <p className="text-sm text-muted-foreground mt-4 leading-relaxed">
                {p.description}
              </p>
            )}

            {/* Social links */}
            {p?.linktree && Object.keys(p.linktree).length > 0 && (
              <div className="flex flex-wrap gap-2 mt-4">
                {p.linktree.website && (
                  <a
                    href={p.linktree.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Globe className="h-3 w-3" /> Website
                  </a>
                )}
                {p.linktree.github && (
                  <a
                    href={`https://github.com/${p.linktree.github}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Github className="h-3 w-3" /> {p.linktree.github}
                  </a>
                )}
                {p.linktree.twitter && (
                  <a
                    href={`https://twitter.com/${p.linktree.twitter}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Twitter className="h-3 w-3" /> @{p.linktree.twitter}
                  </a>
                )}
              </div>
            )}
          </GlowCard>

          {/* Agent Market metadata */}
          {am && (
            <GlowCard className="p-6">
              <h2 className="text-sm font-semibold text-foreground mb-3">
                Agent Market Registration
              </h2>
              <div className="grid grid-cols-2 gap-4 text-sm">
                {am.handle && (
                  <div>
                    <p className="text-xs text-muted-foreground">Handle</p>
                    <p className="font-mono text-foreground">@{am.handle}</p>
                  </div>
                )}
                {am.registered_at && (
                  <div>
                    <p className="text-xs text-muted-foreground">Registered</p>
                    <p className="text-foreground">
                      {new Date(am.registered_at).toLocaleDateString()}
                    </p>
                  </div>
                )}
                {am.capabilities && am.capabilities.length > 0 && (
                  <div className="col-span-2">
                    <p className="text-xs text-muted-foreground mb-1">
                      Capabilities
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {am.capabilities.map((cap) => (
                        <span
                          key={cap}
                          className="px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary"
                        >
                          {cap}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </GlowCard>
          )}

          {/* View on NEAR Social */}
          <div className="flex gap-3">
            <a
              href={EXTERNAL_URLS.NEAR_SOCIAL_PROFILE(accountId)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-border text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ExternalLink className="h-3 w-3" />
              View on NEAR Social
            </a>
            <a
              href={EXTERNAL_URLS.NEARBLOCKS(accountId)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-border text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ExternalLink className="h-3 w-3" />
              View on NearBlocks
            </a>
          </div>
        </>
      )}
    </div>
  );
}
