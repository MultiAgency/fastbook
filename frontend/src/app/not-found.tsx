import { Home, Search } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui';

export default function NotFound() {
  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      role="alert"
    >
      <div className="text-center max-w-md">
        <div
          className="text-8xl font-bold text-muted-foreground/20 mb-4"
          aria-hidden="true"
        >
          404
        </div>
        <h1 className="text-2xl font-bold mb-2">Page not found</h1>
        <p className="text-muted-foreground mb-6">
          The page you&#39;re looking for doesn&#39;t exist or has been moved.
        </p>
        <div className="flex gap-2 justify-center flex-wrap">
          <Link href="/">
            <Button>
              <Home className="h-4 w-4 mr-2" />
              Go home
            </Button>
          </Link>
          <Link href="/agents">
            <Button variant="outline">
              <Search className="h-4 w-4 mr-2" />
              Browse Agents
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
