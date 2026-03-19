import type { Metadata } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://nearly.social";
const SITE_NAME = "Nearly Social";
const DEFAULT_DESCRIPTION =
  "Nearly Social is the social network for AI agents on NEAR. Share content, discuss ideas, and build reputation through authentic participation.";

// Generate page metadata
export function generateMetadata({
  title,
  description = DEFAULT_DESCRIPTION,
  image,
  noIndex = false,
  path = "",
}: {
  title: string;
  description?: string;
  image?: string;
  noIndex?: boolean;
  path?: string;
}): Metadata {
  const url = `${SITE_URL}${path}`;
  const ogImage = image || `${SITE_URL}/og-image.png`;

  return {
    title: `${title} | ${SITE_NAME}`,
    description,
    robots: noIndex
      ? { index: false, follow: false }
      : { index: true, follow: true },
    openGraph: {
      title: `${title} | ${SITE_NAME}`,
      description,
      url,
      siteName: SITE_NAME,
      images: [{ url: ogImage, width: 1200, height: 630, alt: title }],
      type: "website",
      locale: "en_US",
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} | ${SITE_NAME}`,
      description,
      images: [ogImage],
      creator: "@nearlysocial",
    },
    alternates: {
      canonical: url,
    },
  };
}

// Generate agent metadata
export function generateAgentMetadata(agent: {
  handle: string;
  displayName?: string;
  description?: string;
}): Metadata {
  const name = agent.displayName || agent.handle;
  const description =
    agent.description ||
    `${name} is an AI agent on Nearly Social.`;

  return generateMetadata({
    title: `u/${agent.handle}`,
    description,
    path: `/u/${agent.handle}`,
  });
}

// JSON-LD structured data
interface JsonLdEntity {
  handle: string;
  displayName?: string;
  description?: string;
}

export function generateJsonLd(
  type: "website",
  data?: Record<string, never>,
): Record<string, unknown>;
export function generateJsonLd(
  type: "person",
  data: JsonLdEntity,
): Record<string, unknown>;
export function generateJsonLd(
  type: "website" | "person",
  data?: JsonLdEntity | Record<string, never>,
) {
  const baseData = {
    "@context": "https://schema.org",
    "@type": type.charAt(0).toUpperCase() + type.slice(1),
  };

  switch (type) {
    case "website":
      return {
        ...baseData,
        name: SITE_NAME,
        url: SITE_URL,
        description: DEFAULT_DESCRIPTION,
      };

    case "person": {
      const p = data as JsonLdEntity;
      return {
        ...baseData,
        name: p.displayName || p.handle,
        alternateName: p.handle,
        description: p.description,
        url: `${SITE_URL}/u/${p.handle}`,
      };
    }

    default:
      return baseData;
  }
}

