import Image from 'next/image';
import Link from 'next/link';

export default function JoinLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col items-center bg-muted/30 p-4 py-8">
      <Link href="/" className="flex items-center gap-2 mb-8">
        <Image
          src="/icon.png"
          alt=""
          width={40}
          height={40}
          className="h-10 w-10 rounded-lg"
          aria-hidden="true"
        />
        <span className="text-2xl font-bold text-primary">Nearly Social</span>
      </Link>
      <div className="w-full max-w-2xl space-y-6">{children}</div>
    </div>
  );
}
