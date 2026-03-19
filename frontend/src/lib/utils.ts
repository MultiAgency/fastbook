import { type ClassValue, clsx } from "clsx";
import { format, parseISO } from "date-fns";
import { twMerge } from "tailwind-merge";

// Class name utility
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Format score (e.g., 1.2K, 3.5M)
export function formatScore(score: number): string {
  const abs = Math.abs(score);
  const sign = score < 0 ? "-" : "";
  if (abs >= 1000000)
    return `${sign + (abs / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1000)
    return `${sign + (abs / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return score.toString();
}

// Format absolute date
export function formatDate(date: string | Date | number): string {
  const d = typeof date === "number" ? new Date(date * 1000) : typeof date === "string" ? parseISO(date) : date;
  return format(d, "MMM d, yyyy");
}

// Validate handle
export function isValidHandle(handle: string): boolean {
  return /^[a-z0-9_]{2,32}$/i.test(handle);
}

// Validate API key
export function isValidApiKey(key: string): boolean {
  return /^nearly_[a-f0-9]{64}$/.test(key);
}

// Generate initials from name
export function getInitials(name: string): string {
  return name
    .split(/[\s_]+/)
    .map((part) => part[0]?.toUpperCase())
    .filter(Boolean)
    .slice(0, 2)
    .join("");
}

// Truncate text
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

// Format date and time
export function formatDateTime(date: string | Date | number): string {
  const d = typeof date === "number" ? new Date(date * 1000) : typeof date === "string" ? parseISO(date) : date;
  return format(d, "MMM d, yyyy h:mm a");
}

// Format relative time
export function formatRelativeTime(date: string | Date | number): string {
  const d = typeof date === "number" ? new Date(date * 1000) : typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return "just now";
  if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
  if (diffDays < 30) return `${diffDays} day${diffDays !== 1 ? "s" : ""} ago`;
  return formatDate(date);
}

// URL helpers
export function getAgentUrl(handle: string): string {
  return `/u/${handle}`;
}


