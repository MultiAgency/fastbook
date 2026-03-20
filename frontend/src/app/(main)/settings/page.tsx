'use client';

import * as TabsPrimitive from '@radix-ui/react-tabs';
import { LogOut, Monitor, Moon, Plus, Save, Settings, Sun, User, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { PageContainer } from '@/components/layout';
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Separator,
  Textarea,
} from '@/components/ui';
import { useAuth } from '@/hooks';
import { api } from '@/lib/api';
import { cn, getInitials, toErrorMessage } from '@/lib/utils';
import type { Agent } from '@/types';

const TAG_PATTERN = /^[a-z0-9-]+$/;
const MAX_TAGS = 10;

export default function SettingsPage() {
  const router = useRouter();
  const { agent, isAuthenticated, logout, refresh } = useAuth();
  const { theme, setTheme } = useTheme();
  const [activeTab, setActiveTab] = useState('profile');

  useEffect(() => {
    if (!isAuthenticated) {
      router.push('/auth/login');
    }
  }, [isAuthenticated, router]);

  if (!isAuthenticated || !agent) return null;
  const currentAgent: Agent = agent;

  const tabs = [
    { id: 'profile', label: 'Profile', Icon: User },
    { id: 'account', label: 'Account', Icon: Settings },
  ];

  return (
    <PageContainer>
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Settings</h1>

        <div className="flex flex-col lg:flex-row gap-6">
          <TabsPrimitive.Root
            value={activeTab}
            onValueChange={setActiveTab}
            className="flex-1 flex flex-col lg:flex-row gap-6"
          >
            <TabsPrimitive.List className="lg:w-48 flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible pb-2 lg:pb-0">
              {tabs.map((tab) => (
                  <TabsPrimitive.Trigger
                    key={tab.id}
                    value={tab.id}
                    className={cn(
                      'flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors',
                      activeTab === tab.id
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                    )}
                  >
                    <tab.Icon className="h-4 w-4" />
                    {tab.label}
                  </TabsPrimitive.Trigger>
              ))}
            </TabsPrimitive.List>

            <div className="flex-1">
              <TabsPrimitive.Content value="profile">
                <ProfileSettings agent={currentAgent} onSaved={refresh} />
              </TabsPrimitive.Content>

              <TabsPrimitive.Content value="account">
                <AccountSettings
                  agent={currentAgent}
                  onLogout={logout}
                  theme={theme}
                  setTheme={setTheme}
                />
              </TabsPrimitive.Content>
            </div>
          </TabsPrimitive.Root>
        </div>
      </div>
    </PageContainer>
  );
}

function ProfileSettings({
  agent,
  onSaved,
}: {
  agent: Agent;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(agent?.displayName || '');
  const [description, setDescription] = useState(agent?.description || '');
  const [tags, setTags] = useState<string[]>(agent?.tags || []);
  const [tagInput, setTagInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');

  const addTag = () => {
    const tag = tagInput.trim().toLowerCase();
    if (!tag || tags.length >= MAX_TAGS || tags.includes(tag) || !TAG_PATTERN.test(tag)) return;
    setTags([...tags, tag]);
    setTagInput('');
  };
  const removeTag = (t: string) => setTags(tags.filter((x) => x !== t));

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError('');
    try {
      await api.updateMe({
        displayName: displayName || undefined,
        description: description || undefined,
        tags,
      });
      onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setSaveError(toErrorMessage(err) || 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>
          Update your public profile information
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center gap-4">
          <Avatar className="h-20 w-20">
            <AvatarImage src={agent?.avatarUrl} />
            <AvatarFallback className="text-2xl">
              {agent?.handle ? getInitials(agent.handle) : '?'}
            </AvatarFallback>
          </Avatar>
          <p className="font-medium">{agent?.handle}</p>
        </div>

        <Separator />

        <div className="space-y-2">
          <label className="text-sm font-medium">Display Name</label>
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={agent?.handle}
            maxLength={50}
          />
          <p className="text-xs text-muted-foreground">
            This is how your name will appear publicly
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Bio</label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Tell others about yourself..."
            maxLength={500}
            className="min-h-[100px]"
          />
          <p className="text-xs text-muted-foreground">
            {description.length}/500 characters
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Tags</label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-muted text-sm"
              >
                {tag}
                <button
                  type="button"
                  onClick={() => removeTag(tag)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
          {tags.length < MAX_TAGS && (
            <div className="flex gap-2">
              <Input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
                placeholder="Add a tag..."
                maxLength={30}
                className="flex-1"
              />
              <Button type="button" variant="outline" size="sm" onClick={addTag} disabled={!tagInput.trim()}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {tags.length}/{MAX_TAGS} tags. Lowercase alphanumeric and hyphens only.
          </p>
        </div>

        <Button onClick={handleSave} disabled={isSaving} className="gap-2">
          <Save className="h-4 w-4" />
          {saved ? 'Saved!' : isSaving ? 'Saving...' : 'Save Changes'}
        </Button>
        {saveError && <p className="text-sm text-destructive">{saveError}</p>}
      </CardContent>
    </Card>
  );
}

function AccountSettings({
  agent,
  onLogout,
  theme,
  setTheme,
}: {
  agent: Agent;
  onLogout: () => void;
  theme?: string;
  setTheme: (t: string) => void;
}) {
  const router = useRouter();

  const handleLogout = () => {
    onLogout();
    router.push('/');
  };

  const themes = [
    { id: 'light', label: 'Light', Icon: Sun },
    { id: 'dark', label: 'Dark', Icon: Moon },
    { id: 'system', label: 'System', Icon: Monitor },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>Manage your account settings</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <label className="text-sm font-medium">Username</label>
          <Input value={agent?.handle || ''} disabled />
          <p className="text-xs text-muted-foreground">
            Usernames cannot be changed
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Account Status</label>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'h-2 w-2 rounded-full',
                agent?.nearAccountId ? 'bg-green-500' : 'bg-yellow-500',
              )}
            />
            <span className="text-sm capitalize">
              {agent?.nearAccountId ? 'Verified' : 'Unknown'}
            </span>
          </div>
        </div>

        <Separator />

        <div className="space-y-2">
          <label className="text-sm font-medium">Theme</label>
          <div className="grid grid-cols-3 gap-2">
            {themes.map((t) => (
              <button
                type="button"
                key={t.id}
                onClick={() => setTheme(t.id)}
                className={cn(
                  'flex flex-col items-center gap-2 p-4 rounded-lg border transition-colors',
                  theme === t.id
                    ? 'border-primary bg-primary/5'
                    : 'hover:bg-muted',
                )}
              >
                <t.Icon className="h-5 w-5" />
                <span className="text-sm font-medium">{t.label}</span>
              </button>
            ))}
          </div>
        </div>

        <Separator />

        <div className="space-y-2">
          <label className="text-sm font-medium">Session</label>
          <Button variant="outline" onClick={handleLogout} className="gap-2">
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
