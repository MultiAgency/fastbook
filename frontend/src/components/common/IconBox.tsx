export function IconBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
      {children}
    </div>
  );
}
